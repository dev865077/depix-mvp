/**
 * Autorizacao explicita para rotas operacionais.
 *
 * O namespace `/ops` existe para suporte e reconciliacao manual. Essas rotas
 * nao devem ficar abertas apenas por terem `tenantId` no path, porque esse
 * identificador sozinho nao representa permissao operacional.
 *
 * O contrato comum das rotas operacionais e:
 * - cada rota so fica habilitada quando sua propria feature flag esta `true`
 * - a rota so fica habilitada quando o bearer operacional esperado existe
 * - o operador precisa enviar `Authorization: Bearer <token>`
 * - quando o tenant declarar `opsBindings.depositRecheckBearerToken`, ele tem precedencia
 * - remover ou rotacionar o binding desabilita a operacao sem redeploy de codigo
 */
import { readSecretBindingValue } from "../config/tenants.js";
import { log } from "../lib/logger.js";
import type { WorkerEnv } from "../types/runtime";

export const ENABLE_OPS_DEPOSIT_RECHECK_BINDING = "ENABLE_OPS_DEPOSIT_RECHECK";
export const ENABLE_OPS_DEPOSITS_FALLBACK_BINDING = "ENABLE_OPS_DEPOSITS_FALLBACK";
export const OPS_ROUTE_BEARER_TOKEN_BINDING = "OPS_ROUTE_BEARER_TOKEN";

type OpsAuthScope = "tenant" | "global";

export type OpsRouteOperation = {
  runtimeKey: string;
  featureFlagBindingName: string;
  invalidFlagCode: string;
  disabledCode: string;
};

type OpsRuntimeConfig = {
  environment: string;
  operations?: Record<string, {
    enabled?: boolean;
    featureFlag?: {
      configured?: boolean;
      recognized?: boolean;
      rawValue?: string | null;
    };
  }>;
};

type OpsRouteTenant = {
  tenantId: string;
  opsBindings?: {
    depositRecheckBearerToken?: string;
  };
};

type OpsRouteAuthorizationInput = {
  env: WorkerEnv | Record<string, unknown>;
  runtimeConfig: OpsRuntimeConfig;
  operation?: OpsRouteOperation;
  authorizationHeader?: string;
  requestId?: string;
  tenant?: OpsRouteTenant;
  tenantId?: string;
  path?: string;
};

type ResolvedOpsBearerToken = {
  bindingName: string;
  authScope: OpsAuthScope;
  token: string;
};

export type OpsRouteAuthorizationContext = {
  bindingName: string;
  authScope: OpsAuthScope;
};

const DEPOSIT_RECHECK_OPERATION: OpsRouteOperation = {
  runtimeKey: "depositRecheck",
  featureFlagBindingName: ENABLE_OPS_DEPOSIT_RECHECK_BINDING,
  invalidFlagCode: "ops_route_disabled_invalid_flag",
  disabledCode: "ops_route_disabled",
};

/**
 * Resolve apenas o gate de feature-flag de uma operacao `/ops`.
 *
 * Algumas rotas operacionais mutam agregados financeiros e precisam de rollout
 * explicito por flag; outras, como diagnostico autenticado de webhook, dependem
 * apenas do bearer operacional. Separar este passo permite reutilizar a mesma
 * autorizacao sem acoplar toda rota `/ops` ao contrato de flag financeira.
 *
 * @param {{
 *   runtimeConfig: {
 *     environment: string,
 *     operations?: Record<string, {
 *       enabled?: boolean,
 *       featureFlag?: {
 *         configured?: boolean,
 *         recognized?: boolean,
 *         rawValue?: string | null
 *       }
 *     }>
 *   },
 *   operation?: {
 *     runtimeKey: string,
 *     featureFlagBindingName: string,
 *     invalidFlagCode: string,
 *     disabledCode: string
 *   },
 *   tenantId?: string
 * }} input Dependencias e metadados da rota.
 * @returns {void}
 */
export function assertOpsOperationEnabled(input: Pick<OpsRouteAuthorizationInput, "runtimeConfig" | "operation" | "tenantId">): void {
  const operation = input.operation ?? DEPOSIT_RECHECK_OPERATION;
  const featureFlag = input.runtimeConfig.operations?.[operation.runtimeKey]?.featureFlag;

  if (featureFlag?.configured && !featureFlag.recognized) {
    throw new OpsRouteAuthorizationError(
      503,
      operation.invalidFlagCode,
      `Operational route is disabled because ${operation.featureFlagBindingName} has an invalid value.`,
      {
        bindingName: operation.featureFlagBindingName,
        environment: input.runtimeConfig.environment,
        tenantId: input.tenantId,
        rawValue: featureFlag.rawValue ?? null,
      },
    );
  }

  if (!input.runtimeConfig.operations?.[operation.runtimeKey]?.enabled) {
    throw new OpsRouteAuthorizationError(
      503,
      operation.disabledCode,
      `Operational route is disabled because ${operation.featureFlagBindingName} is not enabled.`,
      {
        bindingName: operation.featureFlagBindingName,
        environment: input.runtimeConfig.environment,
        tenantId: input.tenantId,
      },
    );
  }
}

/**
 * Erro controlado de autorizacao de rota operacional.
 */
export class OpsRouteAuthorizationError extends Error {
  status: number;
  code: string;
  details: Record<string, unknown>;

  /**
   * @param {number} status Status HTTP esperado na borda.
   * @param {string} code Codigo estavel.
   * @param {string} message Mensagem principal.
   * @param {Record<string, unknown>=} details Metadados adicionais.
   * @param {unknown} [cause] Erro original.
   */
  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}, cause?: unknown) {
    super(message, { cause });
    this.name = "OpsRouteAuthorizationError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Le o token esperado para a rota operacional.
 *
 * Ordem de precedencia:
 * 1. token tenant-scoped declarado no `TENANT_REGISTRY`
 * 2. token global (`OPS_ROUTE_BEARER_TOKEN`)
 *
 * Isso reduz blast radius quando o time decidir operar com segredos por tenant
 * sem quebrar o contrato ja publicado do token global.
 *
 * @param {Record<string, unknown>} env Bindings do Worker.
 * @param {{ tenantId: string, opsBindings?: { depositRecheckBearerToken?: string } } | undefined} tenant Tenant atual.
 * @returns {Promise<{ bindingName: string, authScope: "tenant" | "global", token: string }>} Segredo esperado.
 */
async function readExpectedOpsBearerToken(
  env: WorkerEnv | Record<string, unknown>,
  tenant: OpsRouteTenant | undefined,
): Promise<ResolvedOpsBearerToken> {
  const tenantScopedBindingName = tenant?.opsBindings?.depositRecheckBearerToken;

  if (tenantScopedBindingName) {
    // A declaracao no registry e autoritativa: se o tenant apontou para um
    // binding proprio e ele estiver ausente ou vazio no ambiente, o read abaixo
    // falha fechado e nenhuma queda para o token global e permitida.
    return {
      bindingName: tenantScopedBindingName,
      authScope: "tenant",
      token: await readSecretBindingValue(env, tenantScopedBindingName),
    };
  }

  return {
    bindingName: OPS_ROUTE_BEARER_TOKEN_BINDING,
    authScope: "global",
    token: await readSecretBindingValue(env, OPS_ROUTE_BEARER_TOKEN_BINDING),
  };
}

export function readBearerTokenFromAuthorizationHeader(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader || typeof authorizationHeader !== "string") {
    return undefined;
  }

  const [scheme, credentials] = authorizationHeader.trim().split(/\s+/, 2);

  if (!scheme || scheme.toLowerCase() !== "bearer") {
    return undefined;
  }

  if (!credentials || credentials.trim().length === 0) {
    return undefined;
  }

  return credentials.trim();
}

/**
 * Compara dois segredos sem sair cedo no primeiro mismatch.
 *
 * @param {string} left Primeiro valor.
 * @param {string} right Segundo valor.
 * @returns {boolean} Verdadeiro quando os valores sao equivalentes.
 */
export function constantTimeStringEquals(left: string, right: string): boolean {
  const maxLength = Math.max(left.length, right.length);
  let diff = left.length === right.length ? 0 : 1;

  for (let index = 0; index < maxLength; index += 1) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }

  return diff === 0;
}

/**
 * Garante que a requisicao operacional autenticada enviou o bearer correto.
 *
 * Esta funcao e a camada compartilhada de autenticacao de `/ops`. Ela nao
 * assume feature flag; apenas resolve o segredo esperado, valida o header e
 * registra negacoes com metadados redigidos.
 *
 * @param {{
 *   env: Record<string, unknown>,
 *   runtimeConfig: {
 *     environment: string
 *   },
 *   authorizationHeader?: string,
 *   requestId?: string,
 *   tenant?: { tenantId: string, opsBindings?: { depositRecheckBearerToken?: string } },
 *   tenantId?: string,
 *   path?: string
 * }} input Dependencias e metadados da requisicao.
 * @returns {Promise<{ bindingName: string, authScope: "tenant" | "global" }>} Contexto de auth selecionado.
 */
export async function authorizeOpsRequest(input: OpsRouteAuthorizationInput): Promise<OpsRouteAuthorizationContext> {
  let expectedBearerToken: string | undefined;
  let expectedBearerBindingName: string | undefined;
  let expectedAuthScope: OpsAuthScope | undefined;
  const tenantScopedBindingName = input.tenant?.opsBindings?.depositRecheckBearerToken;

  try {
    const resolvedBearerToken = await readExpectedOpsBearerToken(input.env, input.tenant);

    expectedBearerToken = resolvedBearerToken.token;
    expectedBearerBindingName = resolvedBearerToken.bindingName;
    expectedAuthScope = resolvedBearerToken.authScope;
  } catch (error) {
    throw new OpsRouteAuthorizationError(
      503,
      "ops_route_disabled",
      "Operational route is disabled because its bearer token is not configured.",
      {
        bindingName: expectedBearerBindingName ?? tenantScopedBindingName ?? OPS_ROUTE_BEARER_TOKEN_BINDING,
        environment: input.runtimeConfig.environment,
        tenantId: input.tenantId,
      },
      error,
    );
  }

  const providedBearerToken = readBearerTokenFromAuthorizationHeader(input.authorizationHeader);

  if (!expectedBearerToken || !expectedBearerBindingName || !expectedAuthScope) {
    throw new OpsRouteAuthorizationError(
      503,
      "ops_route_disabled",
      "Operational route is disabled because its bearer token is not configured.",
      {
        bindingName: expectedBearerBindingName ?? tenantScopedBindingName ?? OPS_ROUTE_BEARER_TOKEN_BINDING,
        environment: input.runtimeConfig.environment,
        tenantId: input.tenantId,
      },
    );
  }

  if (!providedBearerToken) {
    log(input.runtimeConfig, {
      level: "warn",
      message: "ops.route_authorization_denied",
      tenantId: input.tenantId,
      requestId: input.requestId,
      details: {
        reason: "missing_or_malformed_bearer_token",
        path: input.path,
        bindingName: expectedBearerBindingName,
        authScope: expectedAuthScope,
      },
    });

    throw new OpsRouteAuthorizationError(
      401,
      "ops_authorization_required",
      "Authorization Bearer token is required for this operational route.",
      {
        header: "Authorization",
        scheme: "Bearer",
        bindingName: expectedBearerBindingName,
        authScope: expectedAuthScope,
      },
    );
  }

  if (!constantTimeStringEquals(providedBearerToken, expectedBearerToken)) {
    log(input.runtimeConfig, {
      level: "warn",
      message: "ops.route_authorization_denied",
      tenantId: input.tenantId,
      requestId: input.requestId,
      details: {
        reason: "invalid_bearer_token",
        path: input.path,
        bindingName: expectedBearerBindingName,
        authScope: expectedAuthScope,
      },
    });

    throw new OpsRouteAuthorizationError(
      403,
      "ops_authorization_invalid",
      "Authorization Bearer token is invalid for this operational route.",
      {
        header: "Authorization",
        scheme: "Bearer",
        bindingName: expectedBearerBindingName,
        authScope: expectedAuthScope,
      },
    );
  }

  return {
    bindingName: expectedBearerBindingName,
    authScope: expectedAuthScope,
  };
}

/**
 * Garante que a rota operacional esteja habilitada e autenticada.
 *
 * @param {{
 *   env: Record<string, unknown>,
 *   runtimeConfig: {
 *     environment: string,
 *     operations?: {
 *       depositRecheck?: {
 *         enabled?: boolean,
 *         featureFlag?: {
 *           configured?: boolean,
 *           recognized?: boolean,
 *           rawValue?: string | null
 *         }
 *       }
 *     }
 *   },
 *   operation?: {
 *     runtimeKey: string,
 *     featureFlagBindingName: string,
 *     invalidFlagCode: string,
 *     disabledCode: string
 *   },
 *   authorizationHeader?: string,
 *   requestId?: string,
 *   tenant?: { tenantId: string, opsBindings?: { depositRecheckBearerToken?: string } },
 *   tenantId?: string,
 *   path?: string
 * }} input Dependencias e metadados da requisicao.
 * @returns {Promise<{ bindingName: string, authScope: "tenant" | "global" }>} Contexto de auth selecionado.
 */
export async function authorizeOpsRoute(input: OpsRouteAuthorizationInput): Promise<OpsRouteAuthorizationContext> {
  assertOpsOperationEnabled(input);

  return authorizeOpsRequest(input);
}
