/**
 * Bootstrap e cache do runtime Telegram baseado em grammY.
 *
 * Esta camada existe para separar:
 * - a presenca do bot/runtime dentro do Worker
 * - a futura logica de webhook da issue seguinte
 *
 * Assim, a aplicacao passa a ter uma fronteira explicita para o runtime do
 * Telegram sem ja acoplar transporte, regras de negocio e maquina de estados.
 *
 * Nesta fase o bootstrap e propositalmente "lazy": o Worker registra o runtime
 * do grammY e deixa a criacao efetiva do bot para a issue seguinte, quando o
 * webhook real entrar em cena com os segredos e middlewares corretos.
 */
import { Bot, webhookCallback } from "grammy";

const telegramRuntimeCache = new Map();

/**
 * Gera um username sintetico seguro para o bot bootstrapado.
 *
 * O tenantId pode ganhar hifens ou outros caracteres operacionais ao longo do
 * tempo. Como o `botInfo.username` deve continuar parecendo um username valido
 * do Telegram, normalizamos a string para manter apenas caracteres seguros.
 *
 * @param {string} tenantId Identificador interno do tenant.
 * @returns {string} Username sintetico e estavel para o bootstrap.
 */
function buildBootstrapUsername(tenantId) {
  const normalizedTenantId = tenantId
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return `${normalizedTenantId || "tenant"}_bootstrap_bot`;
}

/**
 * Monta um botInfo sintetico para o bootstrap do grammY.
 *
 * O bot real ainda nao esta fazendo `getMe()` nem processando updates nesta
 * issue. Mesmo assim, deixamos um `botInfo` estavel para que o runtime exista
 * de forma previsivel e sem depender de chamada remota no bootstrap.
 *
 * @param {{ tenantId: string, displayName: string }} tenantConfig Tenant atual.
 * @returns {{ id: number, is_bot: true, first_name: string, username: string, can_join_groups: boolean, can_read_all_group_messages: false, supports_inline_queries: false }} Identidade sintetica do bot.
 */
function buildBootstrapBotInfo(tenantConfig) {
  return {
    id: 0,
    is_bot: true,
    first_name: `${tenantConfig.displayName} Runtime`,
    username: buildBootstrapUsername(tenantConfig.tenantId),
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };
}

/**
 * Cria um bot grammY real para o tenant.
 *
 * O bootstrap do runtime nao chama este helper automaticamente. Isso permite
 * que a issue atual introduza grammY no Worker sem acoplar o caminho de
 * roteamento a segredos que ainda serao validados e usados no webhook real.
 *
 * @param {{ tenantId: string, displayName: string }} tenantConfig Tenant resolvido.
 * @param {string} telegramBotToken Token real do bot no Telegram.
 * @returns {Bot} Instancia do bot pronta para uso futuro.
 */
export function createTelegramBot(tenantConfig, telegramBotToken) {
  return new Bot(telegramBotToken, {
    botInfo: buildBootstrapBotInfo(tenantConfig),
  });
}

/**
 * Cria a estrutura de runtime do Telegram para um tenant especifico.
 *
 * @param {{ tenantId: string, displayName: string, secretBindings: Record<string, string> }} tenantConfig Tenant resolvido.
 * @returns {{
 *   engine: "grammy",
 *   tenantId: string,
 *   botInfo: ReturnType<typeof buildBootstrapBotInfo>,
 *   createBot: (telegramBotToken: string) => Bot,
 *   createWebhookCallback: (telegramBotToken: string) => (request: Request) => Promise<Response>
 * }} Runtime pronto para ser reutilizado.
 */
export function createTelegramRuntime(tenantConfig) {
  const botInfo = buildBootstrapBotInfo(tenantConfig);

  return {
    engine: "grammy",
    tenantId: tenantConfig.tenantId,
    botInfo,
    createBot(telegramBotToken) {
      return createTelegramBot(tenantConfig, telegramBotToken);
    },
    createWebhookCallback(telegramBotToken) {
      const bot = createTelegramBot(tenantConfig, telegramBotToken);

      bot.use(async function attachTenantContext(ctx, next) {
        ctx.state ??= {};
        ctx.state.tenant = {
          tenantId: tenantConfig.tenantId,
          displayName: tenantConfig.displayName,
        };

        await next();
      });

      return webhookCallback(bot, "cloudflare-mod");
    },
  };
}

/**
 * Devolve o runtime do tenant, reaproveitando a instancia quando ela ja foi
 * criada anteriormente dentro do processo atual do Worker.
 *
 * @param {{ tenantId: string, displayName: string, secretBindings: Record<string, string> }} tenantConfig Tenant resolvido.
 * @returns {{
 *   engine: "grammy",
 *   tenantId: string,
 *   botInfo: ReturnType<typeof buildBootstrapBotInfo>,
 *   createBot: (telegramBotToken: string) => Bot,
 *   createWebhookCallback: (telegramBotToken: string) => (request: Request) => Promise<Response>
 * }} Runtime do tenant.
 */
export function getTelegramRuntime(tenantConfig) {
  const cachedRuntime = telegramRuntimeCache.get(tenantConfig.tenantId);

  if (cachedRuntime) {
    return cachedRuntime;
  }

  const runtime = createTelegramRuntime(tenantConfig);

  telegramRuntimeCache.set(tenantConfig.tenantId, runtime);

  return runtime;
}

/**
 * Lista os tenants cujo runtime ja foi materializado no processo atual.
 *
 * @returns {string[]} Tenants com runtime bootstrapado.
 */
export function listBootstrappedTelegramTenants() {
  return [...telegramRuntimeCache.keys()].sort();
}

/**
 * Limpa o cache do runtime Telegram.
 *
 * Esta funcao existe para testes e para eventuais rotinas futuras de reset
 * controlado.
 */
export function clearTelegramRuntimeCache() {
  telegramRuntimeCache.clear();
}
