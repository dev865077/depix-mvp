/**
 * Autorizacao explicita para rotas operacionais.
 *
 * O namespace `/ops` existe para suporte e reconciliacao manual. Essas rotas
 * nao devem ficar abertas apenas por terem `tenantId` no path, porque esse
 * identificador sozinho nao representa permissao operacional.
 *
 * Nesta fase, o contrato do recheck operacional e:
 * - a rota so fica habilitada quando `OPS_ROUTE_BEARER_TOKEN` existe
 * - o operador precisa enviar `Authorization: Bearer <token>`
 * - remover ou rotacionar o binding desabilita a operacao sem redeploy de codigo
 */
import { readSecretBindingValue } from "../config/tenants.js";
import { log } from "../lib/logger.js";

export const OPS_ROUTE_BEARER_TOKEN_BINDING = "OPS_ROUTE_BEARER_TOKEN";

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
 *   runtimeConfig: { environment: string },
 *   authorizationHeader?: string,
 *   requestId?: string,
 *   tenantId?: string,
 *   path?: string
 * }} input Dependencias e metadados da requisicao.
 * @returns {Promise<void>} Resolve apenas quando a borda pode prosseguir.
 */
export async function authorizeOpsRoute(input) {
  let expectedBearerToken;

  try {
    expectedBearerToken = await readSecretBindingValue(input.env, OPS_ROUTE_BEARER_TOKEN_BINDING);
  } catch (error) {
    throw new OpsRouteAuthorizationError(
      503,
      "ops_route_disabled",
      "Operational route is disabled because its bearer token is not configured.",
      {
        bindingName: OPS_ROUTE_BEARER_TOKEN_BINDING,
        environment: input.runtimeConfig.environment,
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
      },
    );
  }
}
