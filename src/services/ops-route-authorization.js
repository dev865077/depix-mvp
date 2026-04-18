/**
 * Autorizacao explicita para rotas operacionais.
 *
 * O namespace `/ops` existe para suporte e reconciliacao manual. Essas rotas
 * nao devem ficar abertas apenas por terem `tenantId` no path, porque esse
 * identificador sozinho nao representa permissao operacional.
 *
 * Nesta fase, o contrato do recheck operacional e:
 * - a rota so fica habilitada quando `ENABLE_OPS_DEPOSIT_RECHECK=true`
 * - a rota so fica habilitada quando `OPS_ROUTE_BEARER_TOKEN` existe
 * - o operador precisa enviar `Authorization: Bearer <token>`
 * - quando existir `OPS_ROUTE_BEARER_TOKEN_<TENANT>`, ele tem precedencia
 * - remover ou rotacionar o binding desabilita a operacao sem redeploy de codigo
 */
import { readSecretBindingValue } from "../config/tenants.js";
import { log } from "../lib/logger.js";

export const ENABLE_OPS_DEPOSIT_RECHECK_BINDING = "ENABLE_OPS_DEPOSIT_RECHECK";
export const OPS_ROUTE_BEARER_TOKEN_BINDING = "OPS_ROUTE_BEARER_TOKEN";
export const OPS_ROUTE_BEARER_TOKEN_TENANT_PREFIX = "OPS_ROUTE_BEARER_TOKEN_";

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
 * Converte o tenant em um sufixo seguro para bindings operacionais.
 *
 * Exemplo:
 * - `alpha` -> `ALPHA`
 * - `cliente-beta` -> `CLIENTE_BETA`
 *
 * @param {string | undefined} tenantId Tenant atual.
 * @returns {string | undefined} Sufixo seguro para o binding.
 */
export function normalizeTenantIdForOpsBinding(tenantId) {
  if (typeof tenantId !== "string" || tenantId.trim().length === 0) {
    return undefined;
  }

  return tenantId.trim().replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}

/**
 * Resolve o nome do binding de token tenant-scoped quando houver tenant.
 *
 * @param {string | undefined} tenantId Tenant atual.
 * @returns {string | undefined} Nome do binding esperado.
 */
export function resolveTenantScopedOpsBearerBindingName(tenantId) {
  const normalizedTenantId = normalizeTenantIdForOpsBinding(tenantId);

  if (!normalizedTenantId) {
    return undefined;
  }

  return `${OPS_ROUTE_BEARER_TOKEN_TENANT_PREFIX}${normalizedTenantId}`;
}

/**
 * Le o token esperado para a rota operacional.
 *
 * Ordem de precedencia:
 * 1. token tenant-scoped (`OPS_ROUTE_BEARER_TOKEN_<TENANT>`)
 * 2. token global (`OPS_ROUTE_BEARER_TOKEN`)
 *
 * Isso reduz blast radius quando o time decidir operar com segredos por tenant
 * sem quebrar o contrato ja publicado do token global.
 *
 * @param {Record<string, unknown>} env Bindings do Worker.
 * @param {string | undefined} tenantId Tenant atual.
 * @returns {Promise<{ bindingName: string, token: string }>} Segredo esperado.
 */
async function readExpectedOpsBearerToken(env, tenantId) {
  const tenantScopedBindingName = resolveTenantScopedOpsBearerBindingName(tenantId);

  if (tenantScopedBindingName) {
    const tenantScopedBindingDeclared = Object.prototype.hasOwnProperty.call(env, tenantScopedBindingName);

    if (tenantScopedBindingDeclared) {
      return {
        bindingName: tenantScopedBindingName,
        token: await readSecretBindingValue(env, tenantScopedBindingName),
      };
    }
  }

  return {
    bindingName: OPS_ROUTE_BEARER_TOKEN_BINDING,
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
 *   runtimeConfig: { environment: string, operations?: { depositRecheckEnabled?: boolean } },
 *   authorizationHeader?: string,
 *   requestId?: string,
 *   tenantId?: string,
 *   path?: string
 * }} input Dependencias e metadados da requisicao.
 * @returns {Promise<void>} Resolve apenas quando a borda pode prosseguir.
 */
export async function authorizeOpsRoute(input) {
  if (!input.runtimeConfig.operations?.depositRecheckEnabled) {
    throw new OpsRouteAuthorizationError(
      503,
      "ops_route_disabled",
      "Operational route is disabled because ENABLE_OPS_DEPOSIT_RECHECK is not enabled.",
      {
        bindingName: ENABLE_OPS_DEPOSIT_RECHECK_BINDING,
        environment: input.runtimeConfig.environment,
        tenantId: input.tenantId,
      },
    );
  }

  let expectedBearerToken;
  let expectedBearerBindingName;
  const tenantScopedBindingName = resolveTenantScopedOpsBearerBindingName(input.tenantId);
  const tenantScopedBindingDeclared = tenantScopedBindingName
    ? Object.prototype.hasOwnProperty.call(input.env, tenantScopedBindingName)
    : false;

  try {
    const resolvedBearerToken = await readExpectedOpsBearerToken(input.env, input.tenantId);

    expectedBearerToken = resolvedBearerToken.token;
    expectedBearerBindingName = resolvedBearerToken.bindingName;
  } catch (error) {
    throw new OpsRouteAuthorizationError(
      503,
      "ops_route_disabled",
      "Operational route is disabled because its bearer token is not configured.",
      {
        bindingName: expectedBearerBindingName
          ?? (tenantScopedBindingDeclared ? tenantScopedBindingName : undefined)
          ?? OPS_ROUTE_BEARER_TOKEN_BINDING,
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
      },
    );
  }
}
