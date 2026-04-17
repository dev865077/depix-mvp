/**
 * Registro e resolucao de tenants do Worker.
 *
 * Esta camada separa metadados nao sensiveis do tenant dos segredos efetivos,
 * permitindo trocar entre Worker Secrets e Secrets Store sem reescrever a
 * logica de negocio.
 */

const REQUIRED_TENANT_SECRET_BINDINGS = [
  "telegramBotToken",
  "telegramWebhookSecret",
  "eulenApiToken",
  "eulenWebhookSecret",
];

/**
 * Valida um campo textual dentro do TENANT_REGISTRY.
 *
 * @param {unknown} value Valor bruto a validar.
 * @param {string} field Caminho logico do campo.
 * @returns {string} Texto limpo e valido.
 */
function assertTenantString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid tenant field: ${field}`);
  }

  return value.trim();
}

/**
 * Normaliza uma entrada bruta do registro de tenants.
 *
 * Este passo garante que cada tenant tenha:
 * - identificador interno
 * - nome de exibicao
 * - parceiro Eulen opcional
 * - nomes dos bindings secretos obrigatorios
 *
 * @param {string} tenantId Chave do tenant no registro.
 * @param {Record<string, unknown>} input Conteudo bruto da entrada.
 * @returns {{
 *   tenantId: string,
 *   displayName: string,
 *   eulenPartnerId?: string,
 *   secretBindings: Record<string, string>
 * }} Tenant validado.
 */
function normalizeTenantConfig(tenantId, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`Invalid TENANT_REGISTRY entry for tenant: ${tenantId}`);
  }

  const secretBindings = input.secretBindings;

  if (!secretBindings || typeof secretBindings !== "object" || Array.isArray(secretBindings)) {
    throw new Error(`Missing secretBindings for tenant: ${tenantId}`);
  }

  const normalizedSecretBindings = {};

  for (const bindingKey of REQUIRED_TENANT_SECRET_BINDINGS) {
    normalizedSecretBindings[bindingKey] = assertTenantString(
      secretBindings[bindingKey],
      `TENANT_REGISTRY.${tenantId}.secretBindings.${bindingKey}`,
    );
  }

  return {
    tenantId,
    displayName: assertTenantString(input.displayName ?? tenantId, `TENANT_REGISTRY.${tenantId}.displayName`),
    eulenPartnerId: typeof input.eulenPartnerId === "string" && input.eulenPartnerId.trim().length > 0
      ? input.eulenPartnerId.trim()
      : undefined,
    secretBindings: normalizedSecretBindings,
  };
}

/**
 * Le o JSON TENANT_REGISTRY e devolve um mapa normalizado por tenant.
 *
 * @param {Record<string, unknown>} env Bindings do Worker.
 * @returns {Record<string, ReturnType<typeof normalizeTenantConfig>>} Registro de tenants pronto para uso.
 */
export function readTenantRegistry(env) {
  const rawRegistry = env.TENANT_REGISTRY;

  if (typeof rawRegistry !== "string" || rawRegistry.trim().length === 0) {
    throw new Error("Missing required binding: TENANT_REGISTRY");
  }

  let parsedRegistry;

  try {
    parsedRegistry = JSON.parse(rawRegistry);
  } catch {
    throw new Error("Invalid JSON binding: TENANT_REGISTRY");
  }

  if (!parsedRegistry || typeof parsedRegistry !== "object" || Array.isArray(parsedRegistry)) {
    throw new Error("Invalid TENANT_REGISTRY shape");
  }

  const entries = Object.entries(parsedRegistry);

  if (entries.length === 0) {
    throw new Error("TENANT_REGISTRY must define at least one tenant");
  }

  return Object.fromEntries(
    entries.map(([tenantId, tenantConfig]) => [tenantId, normalizeTenantConfig(tenantId, tenantConfig)]),
  );
}

/**
 * Extrai o tenant do path de entrada das rotas multi-tenant.
 *
 * @param {string} path Caminho da requisicao atual.
 * @returns {string | undefined} Tenant identificado no path, se existir.
 */
export function resolveTenantIdFromPath(path) {
  const tenantPathPatterns = [
    /^\/telegram\/([^/]+)\/webhook$/,
    /^\/webhooks\/eulen\/([^/]+)\/deposit$/,
    /^\/ops\/([^/]+)\/recheck\/deposit$/,
  ];

  for (const pattern of tenantPathPatterns) {
    const match = path.match(pattern);

    if (match) {
      return match[1];
    }
  }

  return undefined;
}

/**
 * Resolve o tenant atual a partir do path ou de um header interno de fallback.
 *
 * @param {{ tenants: Record<string, ReturnType<typeof normalizeTenantConfig>> }} runtimeConfig Runtime seguro do app.
 * @param {string} path Caminho da requisicao atual.
 * @param {string | undefined} tenantHeader Header alternativo para operacoes internas.
 * @returns {ReturnType<typeof normalizeTenantConfig> | undefined} Tenant encontrado.
 */
export function resolveTenantFromRequest(runtimeConfig, path, tenantHeader) {
  const resolvedTenantId = resolveTenantIdFromPath(path) ?? tenantHeader;

  if (!resolvedTenantId) {
    return undefined;
  }

  return runtimeConfig.tenants[resolvedTenantId];
}

/**
 * Le um segredo por binding.
 *
 * O binding pode ser:
 * - um Worker Secret tradicional, vindo como string
 * - um binding de Secrets Store, exposto com metodo `get()`
 *
 * @param {Record<string, unknown>} env Bindings do Worker.
 * @param {string} bindingName Nome do binding secreto configurado para o tenant.
 * @returns {Promise<string>} Valor do segredo.
 */
export async function readSecretBindingValue(env, bindingName) {
  const binding = env[bindingName];

  if (typeof binding === "string" && binding.trim().length > 0) {
    return binding;
  }

  if (binding && typeof binding === "object" && typeof binding.get === "function") {
    const value = await binding.get();

    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  throw new Error(`Missing required secret binding: ${bindingName}`);
}

/**
 * Materializa os segredos do tenant atual apenas quando forem realmente necessarios.
 *
 * @param {Record<string, unknown>} env Bindings do Worker.
 * @param {ReturnType<typeof normalizeTenantConfig>} tenantConfig Tenant ja resolvido.
 * @returns {Promise<Record<string, string>>} Segredos carregados do tenant.
 */
export async function readTenantSecrets(env, tenantConfig) {
  const secrets = {};

  for (const [secretKey, bindingName] of Object.entries(tenantConfig.secretBindings)) {
    secrets[secretKey] = await readSecretBindingValue(env, bindingName);
  }

  return /** @type {any} */ (secrets);
}
