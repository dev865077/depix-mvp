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

const REQUIRED_TENANT_SPLIT_CONFIG_BINDINGS = [
  "depixSplitAddress",
  "splitFee",
];

const OPTIONAL_TENANT_OPS_BINDING_KEYS = [
  "depositRecheckBearerToken",
] as const;

const DEFAULT_TENANT_REGISTRY_STAGE = "initial_materialization";

type TenantRegistryValidationReason =
  | "missing_required_key"
  | "invalid_type"
  | "empty_binding_name"
  | "malformed_tenant"
  | "invalid_json"
  | "empty_registry";

type TenantRegistryValidationStage = "initial_materialization" | "tenant_lookup";

type ValidationContext = Readonly<{
  tenantId: string | null;
  stage: TenantRegistryValidationStage;
}>;

export type TenantSecretBindingKey =
  | "telegramBotToken"
  | "telegramWebhookSecret"
  | "eulenApiToken"
  | "eulenWebhookSecret";

export type TenantSplitConfigBindings = Readonly<{
  depixSplitAddress: string;
  splitFee: string;
}>;

export type TenantOpsBindings = Readonly<{
  depositRecheckBearerToken?: string;
}>;

export type TenantConfig = Readonly<{
  tenantId: string;
  displayName: string;
  eulenPartnerId?: string;
  splitConfigBindings: TenantSplitConfigBindings;
  opsBindings: TenantOpsBindings;
  secretBindings: Record<TenantSecretBindingKey, string>;
}>;

export type TenantRegistry = Record<string, TenantConfig>;

type SecretBindingValue = {
  get: () => Promise<unknown>;
};

/**
 * Erro canonico para falhas de contrato do TENANT_REGISTRY.
 */
export class TenantRegistryValidationError extends Error {
  /**
   * @param {{
   *   tenantId: string | null,
   *   field: string,
   *   reason: "missing_required_key" | "invalid_type" | "empty_binding_name" | "malformed_tenant" | "invalid_json" | "empty_registry",
   *   stage: "initial_materialization" | "tenant_lookup"
   * }} input Dados estruturados do erro.
   */
  code: "invalid_tenant_registry";
  tenantId: string | null;
  field: string;
  reason: TenantRegistryValidationReason;
  stage: TenantRegistryValidationStage;

  constructor({ tenantId, field, reason, stage }: Readonly<{
    tenantId: string | null;
    field: string;
    reason: TenantRegistryValidationReason;
    stage: TenantRegistryValidationStage;
  }>) {
    super(`Invalid tenant registry: ${field} (${reason})`);
    this.name = "TenantRegistryValidationError";
    this.code = "invalid_tenant_registry";
    this.tenantId = tenantId;
    this.field = field;
    this.reason = reason;
    this.stage = stage;
  }

  toJSON() {
    return {
      code: this.code,
      tenantId: this.tenantId,
      field: this.field,
      reason: this.reason,
      stage: this.stage,
    };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function createValidationContext(
  tenantId: string | null,
  stage: TenantRegistryValidationStage = DEFAULT_TENANT_REGISTRY_STAGE,
): ValidationContext {
  return { tenantId, stage };
}

function throwTenantRegistryValidationError(
  context: ValidationContext,
  field: string,
  reason: TenantRegistryValidationReason,
): never {
  throw new TenantRegistryValidationError({
    tenantId: context.tenantId,
    field,
    reason,
    stage: context.stage,
  });
}

/**
 * Garante que um valor do registry seja um objeto JSON simples.
 *
 * O `TENANT_REGISTRY` vem de uma string JSON versionada/configurada no
 * Wrangler. Validar o shape logo na borda de configuracao evita que rotas de
 * negocio precisem lidar com estados parciais ou campos silenciosamente nulos.
 *
 * @param {unknown} value Valor bruto a validar.
 * @param {string} field Caminho logico do campo.
 * @returns {Record<string, unknown>} Objeto validado.
 */
function assertTenantObject(value: unknown, field: string, context: ValidationContext): Record<string, unknown> {
  if (typeof value === "undefined") {
    throwTenantRegistryValidationError(context, field, "missing_required_key");
  }

  if (!isPlainObject(value)) {
    throwTenantRegistryValidationError(context, field, "malformed_tenant");
  }

  return value;
}

/**
 * Valida um campo textual dentro do TENANT_REGISTRY.
 *
 * @param {unknown} value Valor bruto a validar.
 * @param {string} field Caminho logico do campo.
 * @returns {string} Texto limpo e valido.
 */
function assertTenantString(value: unknown, field: string, context: ValidationContext): string {
  if (typeof value === "undefined") {
    throwTenantRegistryValidationError(context, field, "missing_required_key");
  }

  if (typeof value !== "string") {
    throwTenantRegistryValidationError(context, field, "invalid_type");
  }

  if (value.trim().length === 0) {
    throwTenantRegistryValidationError(context, field, "empty_binding_name");
  }

  return value.trim();
}

/**
 * Normaliza um mapa obrigatorio de bindings por tenant.
 *
 * A funcao recebe o objeto bruto de uma secao do registry e devolve somente
 * os pares esperados. Ela tambem monta caminhos de erro precisos, por exemplo:
 * `TENANT_REGISTRY.alpha.splitConfigBindings.depixSplitAddress`.
 *
 * @param {string} tenantId Chave do tenant no registro.
 * @param {Record<string, unknown>} input Conteudo bruto da secao de bindings.
 * @param {string} registryField Nome da secao dentro do registry.
 * @param {string[]} requiredKeys Chaves obrigatorias esperadas.
 * @returns {Record<string, string>} Mapa de bindings normalizado.
 */
function normalizeTenantBindingMap<Key extends string>(
  tenantId: string,
  input: unknown,
  registryField: string,
  requiredKeys: readonly Key[],
  stage: TenantRegistryValidationStage,
): Record<Key, string> {
  const context = createValidationContext(tenantId, stage);
  const bindingMap = assertTenantObject(input, `TENANT_REGISTRY.${tenantId}.${registryField}`, context);

  return Object.fromEntries(
    requiredKeys.map((bindingKey) => [
      bindingKey,
      assertTenantString(
        bindingMap[bindingKey],
        `TENANT_REGISTRY.${tenantId}.${registryField}.${bindingKey}`,
        context,
      ),
    ]),
  ) as Record<Key, string>;
}

/**
 * Normaliza os bindings secretos obrigatorios da configuracao de split.
 *
 * Endereco de split e fee sao dados financeiros operacionais. Mesmo nao sendo
 * credenciais de gasto, eles nao devem ficar versionados no `TENANT_REGISTRY`.
 * O registry guarda apenas nomes de bindings; os valores reais sao lidos do
 * Secrets Store quando uma cobranca precisa ser criada.
 *
 * @param {string} tenantId Chave do tenant no registro.
 * @param {Record<string, unknown>} input Conteudo bruto dos bindings de split.
 * @returns {{ depixSplitAddress: string, splitFee: string }} Bindings validados.
 */
function normalizeTenantSplitConfigBindings(
  tenantId: string,
  input: unknown,
  stage: TenantRegistryValidationStage,
): TenantSplitConfigBindings {
  return normalizeTenantBindingMap(
    tenantId,
    input,
    "splitConfigBindings",
    REQUIRED_TENANT_SPLIT_CONFIG_BINDINGS,
    stage,
  ) as TenantSplitConfigBindings;
}

/**
 * Normaliza bindings operacionais opcionais do tenant.
 *
 * O recheck manual pode usar um token global compartilhado ou um token proprio
 * por tenant. Quando o tenant declara um binding explicito aqui, o runtime usa
 * exatamente esse nome e deixa de derivar o binding a partir do `tenantId`.
 * Isso elimina colisao por normalizacao e torna a configuracao auditavel.
 *
 * @param {string} tenantId Chave do tenant no registro.
 * @param {unknown} input Conteudo bruto dos bindings operacionais.
 * @returns {{ depositRecheckBearerToken?: string }} Bindings opcionais validados.
 */
function normalizeTenantOpsBindings(
  tenantId: string,
  input: unknown,
  stage: TenantRegistryValidationStage,
): TenantOpsBindings {
  if (typeof input === "undefined") {
    return {};
  }

  const context = createValidationContext(tenantId, stage);
  const opsBindings = assertTenantObject(input, `TENANT_REGISTRY.${tenantId}.opsBindings`, context);

  return Object.fromEntries(
    OPTIONAL_TENANT_OPS_BINDING_KEYS.flatMap((bindingKey) => {
      const bindingValue = opsBindings[bindingKey];

      if (typeof bindingValue === "undefined") {
        return [];
      }

      return [[
        bindingKey,
        assertTenantString(bindingValue, `TENANT_REGISTRY.${tenantId}.opsBindings.${bindingKey}`, context),
      ]];
    }),
  ) as TenantOpsBindings;
}

/**
 * Normaliza uma entrada bruta do registro de tenants.
 *
 * Este passo garante que cada tenant tenha:
 * - identificador interno
 * - nome de exibicao
 * - parceiro Eulen opcional
 * - nomes dos bindings secretos obrigatorios
 * - nomes dos bindings secretos obrigatorios de split para cobranca
 * - nomes opcionais de bindings operacionais por tenant
 *
 * @param {string} tenantId Chave do tenant no registro.
 * @param {Record<string, unknown>} input Conteudo bruto da entrada.
 * @returns {{
 *   tenantId: string,
 *   displayName: string,
 *   eulenPartnerId?: string,
 *   splitConfigBindings: {
 *     depixSplitAddress: string,
 *     splitFee: string
 *   },
 *   opsBindings: {
 *     depositRecheckBearerToken?: string
 *   },
 *   secretBindings: Record<string, string>
 * }} Tenant validado.
 */
function normalizeTenantConfig(
  tenantId: string,
  input: unknown,
  stage: TenantRegistryValidationStage = DEFAULT_TENANT_REGISTRY_STAGE,
): TenantConfig {
  const context = createValidationContext(tenantId, stage);
  const tenantConfig = assertTenantObject(input, `TENANT_REGISTRY.${tenantId}`, context);
  const displayName = typeof tenantConfig.displayName === "undefined"
    ? tenantId
    : assertTenantString(tenantConfig.displayName, `TENANT_REGISTRY.${tenantId}.displayName`, context);

  return {
    tenantId,
    displayName,
    eulenPartnerId: typeof tenantConfig.eulenPartnerId === "string" && tenantConfig.eulenPartnerId.trim().length > 0
      ? tenantConfig.eulenPartnerId.trim()
      : undefined,
    splitConfigBindings: normalizeTenantSplitConfigBindings(tenantId, tenantConfig.splitConfigBindings, stage),
    opsBindings: normalizeTenantOpsBindings(tenantId, tenantConfig.opsBindings, stage),
    secretBindings: normalizeTenantBindingMap(
      tenantId,
      tenantConfig.secretBindings,
      "secretBindings",
      REQUIRED_TENANT_SECRET_BINDINGS,
      stage,
    ),
  };
}

/**
 * Le o JSON TENANT_REGISTRY e devolve um mapa normalizado por tenant.
 *
 * @param {Record<string, unknown>} env Bindings do Worker.
 * @returns {Record<string, ReturnType<typeof normalizeTenantConfig>>} Registro de tenants pronto para uso.
 */
export function readTenantRegistry(
  env: Record<string, unknown>,
  options: Readonly<{ stage?: TenantRegistryValidationStage }> = {},
): TenantRegistry {
  const stage = options.stage ?? DEFAULT_TENANT_REGISTRY_STAGE;
  const context = createValidationContext(null, stage);
  const rawRegistry = env.TENANT_REGISTRY;

  if (typeof rawRegistry !== "string" || rawRegistry.trim().length === 0) {
    const reason = typeof rawRegistry === "undefined"
      ? "missing_required_key"
      : typeof rawRegistry !== "string"
        ? "invalid_type"
        : "empty_registry";

    throwTenantRegistryValidationError(
      context,
      "TENANT_REGISTRY",
      reason,
    );
  }

  let parsedRegistry;

  try {
    parsedRegistry = JSON.parse(rawRegistry);
  } catch {
    throwTenantRegistryValidationError(context, "TENANT_REGISTRY", "invalid_json");
  }

  const registry = assertTenantObject(parsedRegistry, "TENANT_REGISTRY", context);

  const entries = Object.entries(registry);

  if (entries.length === 0) {
    throwTenantRegistryValidationError(context, "TENANT_REGISTRY", "empty_registry");
  }

  return Object.fromEntries(
    entries.map(([tenantId, tenantConfig]) => [tenantId, normalizeTenantConfig(tenantId, tenantConfig, stage)]),
  );
}

/**
 * Extrai o tenant do path de entrada das rotas multi-tenant.
 *
 * @param {string} path Caminho da requisicao atual.
 * @returns {string | undefined} Tenant identificado no path, se existir.
 */
export function resolveTenantIdFromPath(path: string): string | undefined {
  const tenantPathPatterns = [
    /^\/telegram\/([^/]+)\/webhook$/,
    /^\/webhooks\/eulen\/([^/]+)\/deposit$/,
    /^\/ops\/([^/]+)\/recheck\/deposit$/,
    /^\/ops\/([^/]+)\/reconcile\/deposits$/,
    /^\/ops\/([^/]+)\/telegram\/webhook-info$/,
    /^\/ops\/([^/]+)\/telegram\/register-webhook$/,
    /^\/ops\/([^/]+)\/eulen\/ping$/,
    /^\/ops\/([^/]+)\/eulen\/create-deposit$/,
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
export function resolveTenantFromRequest(
  runtimeConfig: Readonly<{ tenants: TenantRegistry }>,
  path: string,
  tenantHeader?: string,
): TenantConfig | undefined {
  const resolvedTenantId = resolveTenantIdFromPath(path) ?? tenantHeader;

  if (!resolvedTenantId) {
    return undefined;
  }

  const tenantConfig = runtimeConfig.tenants[resolvedTenantId];

  if (!tenantConfig) {
    return undefined;
  }

  return normalizeTenantConfig(resolvedTenantId, tenantConfig, "tenant_lookup");
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
function isSecretStoreBinding(binding: unknown): binding is SecretBindingValue {
  return Boolean(binding && typeof binding === "object" && "get" in binding && typeof binding.get === "function");
}

export async function readSecretBindingValue(env: Record<string, unknown>, bindingName: string): Promise<string> {
  const binding = env[bindingName];

  if (typeof binding === "string" && binding.trim().length > 0) {
    return binding.trim();
  }

  if (isSecretStoreBinding(binding)) {
    const value = await binding.get();

    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  throw new Error(`Missing required secret binding: ${bindingName}`);
}

/**
 * Resolve o nome de um binding declarado dentro de um mapa do tenant.
 *
 * @param {Record<string, string> | undefined} bindingMap Mapa de bindings do tenant.
 * @param {string} tenantId Tenant usado apenas para mensagens de erro.
 * @param {string} groupName Nome logico do grupo de bindings.
 * @param {string} key Chave logica procurada.
 * @returns {string} Nome do binding no runtime.
 */
function resolveTenantBindingName(
  bindingMap: Readonly<Record<string, string>> | undefined,
  tenantId: string,
  groupName: string,
  key: string,
): string {
  const bindingName = bindingMap?.[key];

  if (typeof bindingName !== "string" || bindingName.trim().length === 0) {
    throw new Error(`Missing required tenant binding mapping: ${tenantId}.${groupName}.${key}`);
  }

  return bindingName;
}

/**
 * Materializa todos os valores de um mapa de bindings.
 *
 * `Promise.all` aqui e intencional: os bindings sao independentes entre si, e
 * ler split address e split fee em paralelo reduz latencia sem mudar semantica.
 *
 * @param {Record<string, unknown>} env Bindings do Worker.
 * @param {Record<string, string>} bindingMap Mapa logico -> nome do binding.
 * @returns {Promise<Record<string, string>>} Mapa logico -> valor secreto.
 */
async function readBindingMapValues<Key extends string>(
  env: Record<string, unknown>,
  bindingMap: Readonly<Record<Key, string>>,
): Promise<Record<Key, string>> {
  const entries = await Promise.all(
    (Object.keys(bindingMap) as Key[]).map(async (key) => [
      key,
      await readSecretBindingValue(env, bindingMap[key]),
    ]),
  );

  return Object.fromEntries(entries) as Record<Key, string>;
}

/**
 * Le um unico segredo declarado no registro do tenant.
 *
 * Isso evita carregar segredos nao relacionados a uma operacao especifica.
 * Assim, rotas da Eulen nao dependem acidentalmente de segredos do Telegram,
 * e vice-versa.
 *
 * @param {Record<string, unknown>} env Bindings do Worker.
 * @param {ReturnType<typeof normalizeTenantConfig>} tenantConfig Tenant ja resolvido.
 * @param {string} secretKey Chave logica do segredo no tenant.
 * @returns {Promise<string>} Valor do segredo solicitado.
 */
export async function readTenantSecret(
  env: Record<string, unknown>,
  tenantConfig: TenantConfig,
  secretKey: TenantSecretBindingKey,
): Promise<string> {
  const tenantId = tenantConfig?.tenantId ?? "unknown";
  const bindingName = resolveTenantBindingName(tenantConfig?.secretBindings, tenantId, "secretBindings", secretKey);

  return readSecretBindingValue(env, bindingName);
}

/**
 * Materializa a configuracao de split sensivel do tenant atual.
 *
 * O `TENANT_REGISTRY` deve conter apenas os nomes dos bindings. Esta funcao e
 * o ponto unico que resolve os valores reais antes de montar o payload da
 * Eulen, evitando vazamento acidental em configuracao versionada ou logs.
 *
 * @param {Record<string, unknown>} env Bindings do Worker.
 * @param {ReturnType<typeof normalizeTenantConfig>} tenantConfig Tenant ja resolvido.
 * @returns {Promise<{ depixSplitAddress: string, splitFee: string }>} Split real materializado.
 */
export async function readTenantSplitConfig(
  env: Record<string, unknown>,
  tenantConfig: TenantConfig,
): Promise<Record<keyof TenantSplitConfigBindings, string>> {
  const splitConfig = await readBindingMapValues(env, tenantConfig.splitConfigBindings);

  return splitConfig;
}

/**
 * Materializa os segredos do tenant atual apenas quando forem realmente necessarios.
 *
 * @param {Record<string, unknown>} env Bindings do Worker.
 * @param {ReturnType<typeof normalizeTenantConfig>} tenantConfig Tenant ja resolvido.
 * @returns {Promise<Record<string, string>>} Segredos carregados do tenant.
 */
export async function readTenantSecrets(
  env: Record<string, unknown>,
  tenantConfig: TenantConfig,
): Promise<Record<TenantSecretBindingKey, string>> {
  const secrets = await readBindingMapValues(env, tenantConfig.secretBindings);

  return secrets;
}
