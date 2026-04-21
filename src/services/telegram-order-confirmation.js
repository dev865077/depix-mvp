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
  resolveCreatedEulenDepositResponse,
} from "../clients/eulen-client.js";
import { readTenantSecret, readTenantSplitConfig } from "../config/tenants.js";
import {
  createDeposit,
  DepositOrderUniquenessError,
  getLatestDepositByOrderId,
} from "../db/repositories/deposits-repository.js";
import { updateOrderByIdWithStepGuard } from "../db/repositories/orders-repository.js";
import {
  advanceOrderProgression,
  ORDER_PROGRESS_EVENTS,
  ORDER_PROGRESS_STATES,
  normalizePersistedOrderProgressStep,
} from "../order-flow/order-progress-machine.js";
import { createTelegramOrderDepositNonce } from "./telegram-order-nonce.js";

const TELEGRAM_CONFIRMATION_FAILURE_MESSAGE = [
  "Nao consegui criar seu Pix agora.",
  "Seu pedido foi encerrado com falha para evitar duplicidade silenciosa.",
  "Envie /start para recomecar com seguranca.",
].join("\n\n");

const TELEGRAM_CONFIRMATION_RECOVERY_MESSAGE = [
  "Seu Pix ainda esta em recuperacao segura.",
  "Nao vou criar outra cobranca enquanto termino de reconciliar este pedido.",
  "Envie confirmar novamente em alguns segundos.",
].join("\n\n");

const SUPPORTED_SPLIT_ADDRESS_KINDS = new Set([
  "documented-depix",
  "liquid-confidential",
]);
const FAIL_CLOSED_RECOVERY_ERROR_CODES = new Set([
  "telegram_order_awaiting_payment_conflict_terminal",
  "telegram_order_awaiting_payment_missing",
  "telegram_order_existing_deposit_invalid",
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
 * O client pode resolver uma resposta async para o shape:
 * `{ response, async: false, resolvedFromAsync: true, originalAsync }`.
 * Nessa situacao, a expiração ainda e valiosa para a UX do Telegram e pode
 * existir apenas em `originalAsync.expiration`.
 *
 * @param {unknown} responseData Envelope normalizado do client Eulen.
 * @returns {{ depositEntryId: string, qrCopyPaste: string, qrImageUrl: string, expiration: string | null }} Deposito pronto para persistencia.
 */
function extractCreatedDeposit(responseData) {
  const payload = responseData?.response;
  const depositEntryId = typeof payload?.id === "string" ? payload.id.trim() : "";
  const qrCopyPaste = typeof payload?.qrCopyPaste === "string" ? payload.qrCopyPaste.trim() : "";
  const qrImageUrl = typeof payload?.qrImageUrl === "string" ? payload.qrImageUrl.trim() : "";
  const payloadExpiration = typeof payload?.expiration === "string" && payload.expiration.trim().length > 0
    ? payload.expiration.trim()
    : null;
  const originalAsyncExpiration = typeof responseData?.originalAsync?.expiration === "string"
    && responseData.originalAsync.expiration.trim().length > 0
    ? responseData.originalAsync.expiration.trim()
    : null;
  const expiration = payloadExpiration ?? originalAsyncExpiration;

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
 * Garante que um deposito local reaproveitado ainda possui os dados minimos
 * para entregar o QR ao usuario.
 *
 * O D1 protege `NOT NULL`, mas nao consegue distinguir uma string vazia de um
 * QR valido. Como a regra nova torna o deposito local autoritativo para retries
 * e concorrencia, a camada de produto precisa recusar explicitamente linhas
 * malformadas em vez de reenviar uma cobranca incompleta ou criar uma segunda
 * cobranca externa.
 *
 * @param {Record<string, unknown>} deposit Deposito lido do repositorio.
 * @param {{ tenantId: string, orderId: string }} context Identidade segura para logs.
 * @returns {Record<string, unknown>} O mesmo deposito, ja validado.
 */
function assertReusableTelegramDeposit(deposit, context) {
  const requiredFields = [
    "depositEntryId",
    "qrCopyPaste",
    "qrImageUrl",
  ];
  const missingFields = requiredFields.filter((field) => {
    const value = deposit[field];

    return typeof value !== "string" || value.trim().length === 0;
  });

  if (missingFields.length === 0) {
    return deposit;
  }

  throw new TelegramOrderConfirmationError(
    "telegram_order_existing_deposit_invalid",
    "Telegram order confirmation found a local deposit that cannot be safely reused.",
    TELEGRAM_CONFIRMATION_FAILURE_MESSAGE,
    {
      tenantId: context.tenantId,
      orderId: context.orderId,
      depositEntryId: typeof deposit.depositEntryId === "string" ? deposit.depositEntryId : null,
      missingFields,
    },
  );
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
 * Persiste a transicao local para `awaiting_payment` a partir de um deposito ja
 * conhecido pelo D1.
 *
 * O helper e usado tanto no caminho feliz quanto no caminho idempotente. Isso
 * garante que retry, concorrencia local ou uma falha parcial ja recuperavel nao
 * disparem nova cobranca externa quando o pedido ja tem deposito associado.
 *
 * @param {{
 *   db: import("@cloudflare/workers-types").D1Database,
 *   tenantId: string,
 *   order: Record<string, unknown>,
 *   deposit: Record<string, unknown>,
 *   splitConfig: { depixSplitAddress: string, splitFee: string }
 * }} input Pedido, deposito e split canonico.
 * @returns {Promise<{ order: Record<string, unknown>, deposit: Record<string, unknown>, accepted: boolean, conflict: boolean, parseResult: null }>} Resultado no shape do service.
 */
async function persistTelegramAwaitingPaymentFromDeposit(input) {
  const reusableDeposit = assertReusableTelegramDeposit(input.deposit, {
    tenantId: input.tenantId,
    orderId: input.order.orderId,
  });
  const depositCreatedProgression = advanceOrderProgression({
    currentStep: input.order.currentStep,
    context: {
      tenantId: input.tenantId,
      orderId: input.order.orderId,
      userId: input.order.userId,
      amountInCents: input.order.amountInCents,
      walletAddress: input.order.walletAddress,
    },
    event: {
      type: ORDER_PROGRESS_EVENTS.DEPOSIT_CREATED,
      tenantId: input.tenantId,
      depositEntryId: reusableDeposit.depositEntryId,
    },
  });
  const awaitingPaymentWrite = await updateOrderByIdWithStepGuard(
    input.db,
    input.tenantId,
    input.order.orderId,
    input.order.currentStep,
    {
      ...depositCreatedProgression.orderPatch,
      splitAddress: input.splitConfig.depixSplitAddress,
      splitFee: input.splitConfig.splitFee,
    },
  );

  if (awaitingPaymentWrite.notFound) {
    throw new TelegramOrderConfirmationError(
      "telegram_order_awaiting_payment_missing",
      "Telegram order disappeared before awaiting_payment persistence could complete.",
      TELEGRAM_CONFIRMATION_FAILURE_MESSAGE,
      {
        tenantId: input.tenantId,
        orderId: input.order.orderId,
        depositEntryId: reusableDeposit.depositEntryId,
      },
    );
  }

  if (awaitingPaymentWrite.conflict) {
    const winnerStep = normalizePersistedOrderProgressStep(awaitingPaymentWrite.order?.currentStep);

    if (winnerStep !== ORDER_PROGRESS_STATES.AWAITING_PAYMENT) {
      throw new TelegramOrderConfirmationError(
        "telegram_order_awaiting_payment_conflict_terminal",
        "Telegram order confirmation found a local deposit but the order won a non-payable state before repair.",
        TELEGRAM_CONFIRMATION_FAILURE_MESSAGE,
        {
          tenantId: input.tenantId,
          orderId: input.order.orderId,
          depositEntryId: reusableDeposit.depositEntryId,
          currentStep: awaitingPaymentWrite.order?.currentStep ?? null,
        },
      );
    }

    return {
      order: awaitingPaymentWrite.order ?? input.order,
      deposit: reusableDeposit,
      accepted: false,
      conflict: true,
      parseResult: null,
    };
  }

  return {
    order: awaitingPaymentWrite.order,
    deposit: reusableDeposit,
    accepted: true,
    conflict: false,
    parseResult: null,
  };
}

/**
 * Confirma o pedido atual e cria a cobranca real na Eulen.
 *
 * O fluxo e deliberadamente sequencial:
 * 1. `confirmation` -> `creating_deposit`
 * 2. chamada real na Eulen somente pelo request que venceu o compare-and-set
 * 3. persistencia em `deposits`
 * 4. `creating_deposit` -> `awaiting_payment`
 *
 * A primeira transicao funciona como lease local: dois `confirmar` concorrentes
 * podem ler o mesmo pedido, mas so um consegue trocar `confirmation` por
 * `creating_deposit`; o perdedor recebe conflito antes de chamar a Eulen. Se um
 * retry chegar depois da criacao, o service reaproveita o deposito ja
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

  if (
    currentStep !== ORDER_PROGRESS_STATES.CONFIRMATION
    && currentStep !== ORDER_PROGRESS_STATES.CREATING_DEPOSIT
  ) {
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

  let creatingDepositOrder = input.order;

  if (currentStep === ORDER_PROGRESS_STATES.CONFIRMATION) {
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

    creatingDepositOrder = confirmationWrite.order;
  }

  const depositNonce = createTelegramOrderDepositNonce(
    {
      tenantId: input.tenant.tenantId,
      orderId: creatingDepositOrder.orderId,
    },
  );

  try {
    const [apiToken, rawSplitConfig] = await Promise.all([
      readTenantSecret(input.env, input.tenant, "eulenApiToken"),
      readTenantSplitConfig(input.env, input.tenant),
    ]);
    const splitConfig = normalizeTelegramSplitConfig(rawSplitConfig);

    assertTelegramSplitConfigReady(input.tenant.tenantId, splitConfig);

    const preexistingDeposit = await getLatestDepositByOrderId(
      input.db,
      input.tenant.tenantId,
      creatingDepositOrder.orderId,
    );

    if (preexistingDeposit) {
      return await persistTelegramAwaitingPaymentFromDeposit({
        db: input.db,
        tenantId: input.tenant.tenantId,
        order: creatingDepositOrder,
        deposit: preexistingDeposit,
        splitConfig,
      });
    }

    const response = await resolveCreatedEulenDepositResponse(
      await createEulenDeposit(input.runtimeConfig, {
        apiToken,
        partnerId: input.tenant.eulenPartnerId,
      }, {
        asyncMode: "auto",
        body: createTelegramEulenDepositPayload(creatingDepositOrder, splitConfig),
        nonce: depositNonce,
        requestId: input.requestContext?.requestId,
      }),
      {
        pollDelayMs: 0,
      },
      input.requestContext?.requestId,
    );
    const createdDeposit = extractCreatedDeposit(response.data);
    let savedDeposit;

    try {
      savedDeposit = await createDeposit(input.db, {
        tenantId: input.tenant.tenantId,
        depositEntryId: createdDeposit.depositEntryId,
        qrId: null,
        orderId: creatingDepositOrder.orderId,
        nonce: depositNonce,
        qrCopyPaste: createdDeposit.qrCopyPaste,
        qrImageUrl: createdDeposit.qrImageUrl,
        externalStatus: "pending",
        expiration: createdDeposit.expiration,
      });
    } catch (error) {
      if (error instanceof DepositOrderUniquenessError && error.existingDeposit) {
        savedDeposit = error.existingDeposit;
      } else if (error instanceof DepositOrderUniquenessError) {
        throw new TelegramOrderConfirmationError(
          "telegram_order_deposit_uniqueness_unresolved",
          "Telegram order confirmation hit the tenant/order uniqueness guard but could not read the winning deposit.",
          TELEGRAM_CONFIRMATION_FAILURE_MESSAGE,
          {
            tenantId: input.tenant.tenantId,
            orderId: creatingDepositOrder.orderId,
            nonce: depositNonce,
          },
          error,
        );
      } else {
        throw new TelegramOrderConfirmationError(
          "telegram_order_deposit_recovery_retryable",
          "Telegram order confirmation received an Eulen deposit but could not persist it locally yet.",
          TELEGRAM_CONFIRMATION_RECOVERY_MESSAGE,
          {
            tenantId: input.tenant.tenantId,
            orderId: creatingDepositOrder.orderId,
            nonce: depositNonce,
            depositEntryId: createdDeposit.depositEntryId,
            cause: error instanceof Error ? error.message : String(error),
          },
          error,
        );
      }
    }

    const persistedDeposit = savedDeposit ?? await getLatestDepositByOrderId(input.db, input.tenant.tenantId, creatingDepositOrder.orderId);

    if (!persistedDeposit) {
      throw new TelegramOrderConfirmationError(
        "telegram_order_deposit_persistence_incomplete",
        "Telegram order confirmation could not read the deposit after local persistence.",
        TELEGRAM_CONFIRMATION_FAILURE_MESSAGE,
        {
          tenantId: input.tenant.tenantId,
          orderId: creatingDepositOrder.orderId,
          depositEntryId: createdDeposit.depositEntryId,
          nonce: depositNonce,
        },
      );
    }

    return await persistTelegramAwaitingPaymentFromDeposit({
      db: input.db,
      tenantId: input.tenant.tenantId,
      order: creatingDepositOrder,
      deposit: persistedDeposit,
      splitConfig,
    });
  } catch (error) {
    if (
      error instanceof TelegramOrderConfirmationError
      && error.code === "telegram_order_deposit_recovery_retryable"
    ) {
      error.details = {
        ...error.details,
        orderId: creatingDepositOrder.orderId,
        tenantId: input.tenant.tenantId,
      };
      throw error;
    }

    if (
      error instanceof TelegramOrderConfirmationError
      && FAIL_CLOSED_RECOVERY_ERROR_CODES.has(error.code)
    ) {
      await markTelegramOrderConfirmationFailure({
        db: input.db,
        tenant: input.tenant,
        order: creatingDepositOrder,
        reason: error.code,
      });
      throw error;
    }

    if (currentStep === ORDER_PROGRESS_STATES.CREATING_DEPOSIT) {
      throw new TelegramOrderConfirmationError(
        "telegram_order_deposit_recovery_retryable",
        "Telegram order confirmation is still recovering a previously leased deposit creation.",
        TELEGRAM_CONFIRMATION_RECOVERY_MESSAGE,
        {
          orderId: creatingDepositOrder.orderId,
          tenantId: input.tenant.tenantId,
          nonce: depositNonce,
          cause: error instanceof Error ? error.message : String(error),
        },
        error,
      );
    }

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
