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

export const ENABLE_OPS_DEPOSIT_RECHECK_BINDING = "ENABLE_OPS_DEPOSIT_RECHECK";
export const ENABLE_OPS_DEPOSITS_FALLBACK_BINDING = "ENABLE_OPS_DEPOSITS_FALLBACK";
export const OPS_ROUTE_BEARER_TOKEN_BINDING = "OPS_ROUTE_BEARER_TOKEN";

const DEPOSIT_RECHECK_OPERATION = {
  runtimeKey: "depositRecheck",
  featureFlagBindingName: ENABLE_OPS_DEPOSIT_RECHECK_BINDING,
  invalidFlagCode: "ops_route_disabled_invalid_flag",
  disabledCode: "ops_route_disabled",
};

/**
 * Erro controlado de autorizacao de rota operacional.
 */
export class OpsRouteAuthorizationError extends Error {
  /**
   * @param {number} status Status HTTP esperado na borda.
   * @param {string} code Codigo estavel.
   * @param {string} message Mensagem principal.
   * @param {Record<string, unknown>=} details Metadados adicionais.
   * @param {unknown} [cause] Erro original.
   */
  constructor(status, code, message, details = {}, cause) {
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
async function readExpectedOpsBearerToken(env, tenant) {
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

/**
 * Extrai um token Bearer do header `Authorization`.
 *
 * @param {string | undefined} authorizationHeader Header bruto recebido.
 * @returns {string | undefined} Token limpo quando o formato e valido.
 */
export function readBearerTokenFromAuthorizationHeader(authorizationHeader) {
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
export function constantTimeStringEquals(left, right) {
  const maxLength = Math.max(left.length, right.length);
  let diff = left.length === right.length ? 0 : 1;

  for (let index = 0; index < maxLength; index += 1) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }

  return diff === 0;
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
export async function authorizeOpsRoute(input) {
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

  let expectedBearerToken;
  let expectedBearerBindingName;
  let expectedAuthScope;
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
