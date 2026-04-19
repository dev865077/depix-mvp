/**
 * Service de confirmacao do pedido Telegram com criacao de deposito Eulen.
 *
 * Esta camada faz a ponte entre o fluxo conversacional e a integracao real:
 * - confirma o resumo do pedido no estado `confirmation`
 * - le secrets e split do tenant sem depender da rota diagnostica
 * - cria a cobranca Pix -> DePix na Eulen
 * - persiste `orders + deposits` sem duplicidade silenciosa
 *
 * O modulo continua sem acoplamento a grammY. O handler do Telegram apenas
 * extrai `env`, `tenant`, `runtimeConfig`, `db` e o pedido atual.
 */
import {
  createEulenDeposit,
  EulenApiError,
  resolveEulenAsyncResponse,
} from "../clients/eulen-client.js";
import { readTenantSecret, readTenantSplitConfig } from "../config/tenants.js";
import {
  createDeposit,
  getLatestDepositByOrderId,
} from "../db/repositories/deposits-repository.js";
import { updateOrderByIdWithStepGuard } from "../db/repositories/orders-repository.js";
import {
  advanceOrderProgression,
  ORDER_PROGRESS_EVENTS,
  ORDER_PROGRESS_STATES,
  normalizePersistedOrderProgressStep,
} from "../order-flow/order-progress-machine.js";

const TELEGRAM_CONFIRMATION_FAILURE_MESSAGE = [
  "Nao consegui criar seu Pix agora.",
  "Seu pedido foi encerrado com falha para evitar duplicidade silenciosa.",
  "Envie /start para recomecar com seguranca.",
].join("\n\n");

const SUPPORTED_SPLIT_ADDRESS_KINDS = new Set([
  "documented-depix",
  "liquid-confidential",
]);

/**
 * Erro controlado do service de confirmacao.
 *
 * O handler do Telegram usa `userMessage` para responder ao usuario sem
 * transformar falha de negocio em retry do webhook.
 */
export class TelegramOrderConfirmationError extends Error {
  /**
   * @param {string} code Codigo estavel para logs e troubleshooting.
   * @param {string} message Mensagem tecnica principal.
   * @param {string} userMessage Mensagem segura para o usuario final.
   * @param {Record<string, unknown>=} details Metadados operacionais.
   * @param {unknown=} cause Erro original.
   */
  constructor(code, message, userMessage, details = {}, cause = undefined) {
    super(message, {
      cause,
    });

    this.name = "TelegramOrderConfirmationError";
    this.code = code;
    this.userMessage = userMessage;
    this.details = details;
  }
}

/**
 * Remove separadores visuais do split materializado no secret.
 *
 * A SideSwap pode exibir o endereco em grupos visuais. A Eulen precisa do
 * valor canonico sem espacos, tabs ou quebras de linha.
 *
 * @param {string} depixSplitAddress Endereco bruto do secret.
 * @returns {string} Endereco canonico.
 */
function normalizeTelegramSplitAddress(depixSplitAddress) {
  return depixSplitAddress.replace(/\s+/gu, "");
}

/**
 * Classifica o endereco de split sem expor o valor real em logs.
 *
 * @param {string} depixSplitAddress Endereco materializado.
 * @returns {"documented-depix" | "liquid-confidential" | "uri" | "unknown"} Familia redigida.
 */
function classifyTelegramSplitAddress(depixSplitAddress) {
  const normalizedAddress = normalizeTelegramSplitAddress(depixSplitAddress).toLowerCase();

  if (normalizedAddress.startsWith("ex1")) {
    return "documented-depix";
  }

  if (normalizedAddress.startsWith("lq1")) {
    return "liquid-confidential";
  }

  if (normalizedAddress.includes(":") || normalizedAddress.includes("?")) {
    return "uri";
  }

  return "unknown";
}

/**
 * Normaliza a configuracao de split para uso no fluxo de produto.
 *
 * @param {{ depixSplitAddress: string, splitFee: string }} splitConfig Split bruto.
 * @returns {{ depixSplitAddress: string, splitFee: string }} Split canonico.
 */
function normalizeTelegramSplitConfig(splitConfig) {
  return {
    depixSplitAddress: normalizeTelegramSplitAddress(splitConfig.depixSplitAddress),
    splitFee: splitConfig.splitFee.trim(),
  };
}

/**
 * Monta o payload final do `POST /deposit` usado pelo fluxo Telegram.
 *
 * O endereco coletado do usuario no passo `wallet` nao pode ficar apenas no
 * pedido local. A criacao do Pix precisa carregar tambem o `depixAddress`
 * final para que a intencao financeira criada na Eulen permaneça vinculada ao
 * destino informado pelo proprio usuario.
 *
 * @param {{
 *   amountInCents: number,
 *   walletAddress: string
 * }} order Pedido confirmado e pronto para criacao do deposito.
 * @param {{ depixSplitAddress: string, splitFee: string }} splitConfig Split materializado do tenant.
 * @returns {{
 *   amountInCents: number,
 *   depixAddress: string,
 *   depixSplitAddress: string,
 *   splitFee: string
 * }} Payload externo canonico.
 */
function createTelegramEulenDepositPayload(order, splitConfig) {
  return {
    amountInCents: order.amountInCents,
    depixAddress: order.walletAddress,
    depixSplitAddress: splitConfig.depixSplitAddress,
    splitFee: splitConfig.splitFee,
  };
}

/**
 * Valida se o split do tenant esta pronto para uma chamada real na Eulen.
 *
 * A confirmacao do pedido nao aceita fallback local nem placeholder. Se o
 * tenant estiver mal configurado, preferimos falhar explicitamente antes de
 * abrir uma cobranca incorreta.
 *
 * @param {string} tenantId Tenant atual.
 * @param {{ depixSplitAddress: string, splitFee: string }} splitConfig Split materializado.
 * @returns {{ depixSplitAddressKind: string, splitFeeLooksPercent: boolean }} Diagnostico seguro.
 */
function assertTelegramSplitConfigReady(tenantId, splitConfig) {
  const depixSplitAddressKind = classifyTelegramSplitAddress(splitConfig.depixSplitAddress);
  const splitFeeLooksPercent = /^\d+(?:\.\d{1,2})%$/u.test(splitConfig.splitFee);

  if (
    SUPPORTED_SPLIT_ADDRESS_KINDS.has(depixSplitAddressKind)
    && splitFeeLooksPercent
  ) {
    return {
      depixSplitAddressKind,
      splitFeeLooksPercent,
    };
  }

  throw new TelegramOrderConfirmationError(
    "telegram_order_split_not_ready",
    `Telegram order confirmation cannot create a deposit because tenant ${tenantId} split config is invalid.`,
    TELEGRAM_CONFIRMATION_FAILURE_MESSAGE,
    {
      tenantId,
      depixSplitAddressKind,
      splitFeeLooksPercent,
    },
  );
}

/**
 * Extrai os campos obrigatorios da resposta de create-deposit.
 *
 * @param {unknown} responseData Envelope normalizado do client Eulen.
 * @returns {{ depositEntryId: string, qrCopyPaste: string, qrImageUrl: string, expiration: string | null }} Deposito pronto para persistencia.
 */
function extractCreatedDeposit(responseData) {
  const payload = responseData?.response;
  const depositEntryId = typeof payload?.id === "string" ? payload.id.trim() : "";
  const qrCopyPaste = typeof payload?.qrCopyPaste === "string" ? payload.qrCopyPaste.trim() : "";
  const qrImageUrl = typeof payload?.qrImageUrl === "string" ? payload.qrImageUrl.trim() : "";
  const expiration = typeof payload?.expiration === "string" && payload.expiration.trim().length > 0
    ? payload.expiration.trim()
    : null;

  if (!depositEntryId || !qrCopyPaste || !qrImageUrl) {
    throw new TelegramOrderConfirmationError(
      "telegram_order_invalid_deposit_response",
      "Eulen deposit response did not contain the required fields for Telegram confirmation.",
      TELEGRAM_CONFIRMATION_FAILURE_MESSAGE,
      {
        hasDepositEntryId: Boolean(depositEntryId),
        hasQrCopyPaste: Boolean(qrCopyPaste),
        hasQrImageUrl: Boolean(qrImageUrl),
      },
    );
  }

  return {
    depositEntryId,
    qrCopyPaste,
    qrImageUrl,
    expiration,
  };
}

/**
 * Avanca o pedido para um passo terminal de falha.
 *
 * A confirmacao nao deixa o pedido preso em `creating_deposit` quando a Eulen
 * falha. Isso simplifica idempotencia e evita que o usuario retome um estado
 * operacionalmente ambiguo.
 *
 * @param {{
 *   db: import("@cloudflare/workers-types").D1Database,
 *   tenant: { tenantId: string },
 *   order: Record<string, unknown>,
 *   reason: string
 * }} input Dependencias e causa da falha.
 * @returns {Promise<Record<string, unknown>>} Pedido apos a tentativa de marcacao.
 */
async function markTelegramOrderConfirmationFailure(input) {
  const progression = advanceOrderProgression({
    currentStep: input.order.currentStep,
    context: {
      tenantId: input.tenant.tenantId,
      orderId: input.order.orderId,
      userId: input.order.userId,
      amountInCents: input.order.amountInCents,
      walletAddress: input.order.walletAddress,
    },
    event: {
      type: ORDER_PROGRESS_EVENTS.FAIL_ORDER,
      tenantId: input.tenant.tenantId,
      reason: input.reason,
    },
  });
  const write = await updateOrderByIdWithStepGuard(
    input.db,
    input.tenant.tenantId,
    input.order.orderId,
    input.order.currentStep,
    progression.orderPatch,
  );

  if (write.order) {
    return write.order;
  }

  return input.order;
}

/**
 * Confirma o pedido atual e cria a cobranca real na Eulen.
 *
 * O fluxo e deliberadamente sequencial:
 * 1. `confirmation` -> `creating_deposit`
 * 2. chamada real na Eulen com secrets do tenant e o endereco final do usuario
 * 3. persistencia em `deposits`
 * 4. `creating_deposit` -> `awaiting_payment`
 *
 * Se um retry chegar depois da criacao, o service reaproveita o deposito ja
 * persistido e nao dispara nova cobranca.
 *
 * @param {{
 *   env: Record<string, unknown>,
 *   db: import("@cloudflare/workers-types").D1Database,
 *   tenant: { tenantId: string, eulenPartnerId?: string, splitConfigBindings: { depixSplitAddress: string, splitFee: string }, secretBindings: Record<string, string> },
 *   runtimeConfig: { eulenApiBaseUrl: string, eulenApiTimeoutMs: number },
 *   order: Record<string, unknown>
 * }} input Dependencias operacionais.
 * @returns {Promise<{
 *   order: Record<string, unknown>,
 *   deposit: Record<string, unknown> | null,
 *   accepted: boolean,
 *   conflict: boolean,
 *   parseResult: null
 * }>} Pedido e deposito resultantes.
 */
export async function confirmTelegramOrder(input) {
  const currentStep = normalizePersistedOrderProgressStep(input.order.currentStep);

  if (currentStep !== ORDER_PROGRESS_STATES.CONFIRMATION) {
    const existingDeposit = await getLatestDepositByOrderId(
      input.db,
      input.tenant.tenantId,
      input.order.orderId,
    );

    return {
      order: input.order,
      deposit: existingDeposit,
      accepted: false,
      conflict: false,
      parseResult: null,
    };
  }

  if (!Number.isSafeInteger(input.order.amountInCents) || typeof input.order.walletAddress !== "string") {
    throw new TelegramOrderConfirmationError(
      "telegram_order_confirmation_incomplete",
      "Telegram order confirmation requires amount and wallet before creating the deposit.",
      TELEGRAM_CONFIRMATION_FAILURE_MESSAGE,
      {
        orderId: input.order.orderId,
        hasAmount: Number.isSafeInteger(input.order.amountInCents),
        hasWalletAddress: typeof input.order.walletAddress === "string" && input.order.walletAddress.length > 0,
      },
    );
  }

  const confirmationProgression = advanceOrderProgression({
    currentStep: input.order.currentStep,
    context: {
      tenantId: input.tenant.tenantId,
      orderId: input.order.orderId,
      userId: input.order.userId,
      amountInCents: input.order.amountInCents,
      walletAddress: input.order.walletAddress,
    },
    event: {
      type: ORDER_PROGRESS_EVENTS.CUSTOMER_CONFIRMED,
      tenantId: input.tenant.tenantId,
    },
  });
  const confirmationWrite = await updateOrderByIdWithStepGuard(
    input.db,
    input.tenant.tenantId,
    input.order.orderId,
    input.order.currentStep,
    confirmationProgression.orderPatch,
  );

  if (confirmationWrite.notFound) {
    throw new TelegramOrderConfirmationError(
      "telegram_order_confirmation_missing",
      "Telegram order disappeared before confirmation could be persisted.",
      TELEGRAM_CONFIRMATION_FAILURE_MESSAGE,
      {
        tenantId: input.tenant.tenantId,
        orderId: input.order.orderId,
      },
    );
  }

  if (confirmationWrite.conflict) {
    const existingDeposit = await getLatestDepositByOrderId(
      input.db,
      input.tenant.tenantId,
      input.order.orderId,
    );

    return {
      order: confirmationWrite.order ?? input.order,
      deposit: existingDeposit,
      accepted: false,
      conflict: true,
      parseResult: null,
    };
  }

  const creatingDepositOrder = confirmationWrite.order;
  try {
    const [apiToken, rawSplitConfig] = await Promise.all([
      readTenantSecret(input.env, input.tenant, "eulenApiToken"),
      readTenantSplitConfig(input.env, input.tenant),
    ]);
    const splitConfig = normalizeTelegramSplitConfig(rawSplitConfig);

    assertTelegramSplitConfigReady(input.tenant.tenantId, splitConfig);

    const response = await resolveEulenAsyncResponse(
      await createEulenDeposit(input.runtimeConfig, {
        apiToken,
        partnerId: input.tenant.eulenPartnerId,
      }, {
        asyncMode: "auto",
        body: createTelegramEulenDepositPayload(creatingDepositOrder, splitConfig),
      }),
      {
        pollDelayMs: 0,
      },
    );
    const createdDeposit = extractCreatedDeposit(response.data);
    const savedDeposit = await createDeposit(input.db, {
      tenantId: input.tenant.tenantId,
      depositEntryId: createdDeposit.depositEntryId,
      qrId: null,
      orderId: creatingDepositOrder.orderId,
      nonce: response.nonce,
      qrCopyPaste: createdDeposit.qrCopyPaste,
      qrImageUrl: createdDeposit.qrImageUrl,
      externalStatus: "pending",
      expiration: createdDeposit.expiration,
    });
    const depositCreatedProgression = advanceOrderProgression({
      currentStep: creatingDepositOrder.currentStep,
      context: {
        tenantId: input.tenant.tenantId,
        orderId: creatingDepositOrder.orderId,
        userId: creatingDepositOrder.userId,
        amountInCents: creatingDepositOrder.amountInCents,
        walletAddress: creatingDepositOrder.walletAddress,
      },
      event: {
        type: ORDER_PROGRESS_EVENTS.DEPOSIT_CREATED,
        tenantId: input.tenant.tenantId,
        depositEntryId: createdDeposit.depositEntryId,
      },
    });
    const awaitingPaymentWrite = await updateOrderByIdWithStepGuard(
      input.db,
      input.tenant.tenantId,
      creatingDepositOrder.orderId,
      creatingDepositOrder.currentStep,
      {
        ...depositCreatedProgression.orderPatch,
        splitAddress: splitConfig.depixSplitAddress,
        splitFee: splitConfig.splitFee,
      },
    );

    if (awaitingPaymentWrite.notFound) {
      throw new TelegramOrderConfirmationError(
        "telegram_order_awaiting_payment_missing",
        "Telegram order disappeared before awaiting_payment persistence could complete.",
        TELEGRAM_CONFIRMATION_FAILURE_MESSAGE,
        {
          tenantId: input.tenant.tenantId,
          orderId: creatingDepositOrder.orderId,
          depositEntryId: createdDeposit.depositEntryId,
        },
      );
    }

    if (awaitingPaymentWrite.conflict) {
      return {
        order: awaitingPaymentWrite.order ?? creatingDepositOrder,
        deposit: savedDeposit ?? await getLatestDepositByOrderId(input.db, input.tenant.tenantId, creatingDepositOrder.orderId),
        accepted: false,
        conflict: true,
        parseResult: null,
      };
    }

    return {
      order: awaitingPaymentWrite.order,
      deposit: savedDeposit ?? await getLatestDepositByOrderId(input.db, input.tenant.tenantId, creatingDepositOrder.orderId),
      accepted: true,
      conflict: false,
      parseResult: null,
    };
  } catch (error) {
    const failedOrder = await markTelegramOrderConfirmationFailure({
      db: input.db,
      tenant: input.tenant,
      order: creatingDepositOrder,
      reason: error instanceof EulenApiError
        ? "eulen_deposit_request_failed"
        : "telegram_order_confirmation_failed",
    });

    if (error instanceof TelegramOrderConfirmationError) {
      error.details = {
        ...error.details,
        orderId: failedOrder.orderId,
      };
      throw error;
    }

    if (error instanceof EulenApiError) {
      throw new TelegramOrderConfirmationError(
        "telegram_order_eulen_request_failed",
        "Telegram order confirmation failed while calling Eulen create-deposit.",
        TELEGRAM_CONFIRMATION_FAILURE_MESSAGE,
        {
          orderId: failedOrder.orderId,
          tenantId: input.tenant.tenantId,
          ...error.details,
        },
        error,
      );
    }

    throw new TelegramOrderConfirmationError(
      "telegram_order_confirmation_failed",
      "Unexpected Telegram order confirmation failure.",
      TELEGRAM_CONFIRMATION_FAILURE_MESSAGE,
      {
        orderId: failedOrder.orderId,
        tenantId: input.tenant.tenantId,
        cause: error instanceof Error ? error.message : String(error),
      },
      error,
    );
  }
}
