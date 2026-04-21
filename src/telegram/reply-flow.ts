import type { Bot } from "grammy";

import type {
  TelegramDepositLike,
  TelegramInvalidAmountParseResult,
  TelegramInvalidWalletParseResult,
  TelegramOrderLike,
  TelegramRuntimeInput,
  TelegramTenant,
} from "./types.js";
import {
  buildTelegramHelpReply as buildTelegramHelpReplyImpl,
  buildTelegramInvalidAmountReply as buildTelegramInvalidAmountReplyImpl,
  buildTelegramInvalidWalletReply as buildTelegramInvalidWalletReplyImpl,
  buildTelegramOrderStepReply as buildTelegramOrderStepReplyImpl,
  buildTelegramStartReply as buildTelegramStartReplyImpl,
  buildTelegramStatusReply as buildTelegramStatusReplyImpl,
  buildTelegramTextReply as buildTelegramTextReplyImpl,
  buildTelegramUnsupportedCallbackReply as buildTelegramUnsupportedCallbackReplyImpl,
  buildTelegramUnsupportedMessageReply as buildTelegramUnsupportedMessageReplyImpl,
  installTelegramReplyFlow as installTelegramReplyFlowImpl,
} from "./reply-flow.runtime.js";

export const installTelegramReplyFlow: (bot: Bot, input: TelegramRuntimeInput) => void = installTelegramReplyFlowImpl;
export const buildTelegramStartReply: (tenant: TelegramTenant) => string = buildTelegramStartReplyImpl;
export const buildTelegramTextReply: (tenant: TelegramTenant) => string = buildTelegramTextReplyImpl;
export const buildTelegramHelpReply: (tenant: TelegramTenant, order: TelegramOrderLike | null) => string = buildTelegramHelpReplyImpl;
export const buildTelegramStatusReply: (
  tenant: TelegramTenant,
  order: TelegramOrderLike | null,
  deposit?: TelegramDepositLike | null,
) => string = buildTelegramStatusReplyImpl;
export const buildTelegramOrderStepReply: (tenant: TelegramTenant, order: TelegramOrderLike) => string = buildTelegramOrderStepReplyImpl;
export const buildTelegramInvalidAmountReply: (parseResult: TelegramInvalidAmountParseResult) => string = buildTelegramInvalidAmountReplyImpl;
export const buildTelegramInvalidWalletReply: (parseResult: TelegramInvalidWalletParseResult) => string = buildTelegramInvalidWalletReplyImpl;
export const buildTelegramUnsupportedMessageReply: (tenant: TelegramTenant) => string = buildTelegramUnsupportedMessageReplyImpl;
export const buildTelegramUnsupportedCallbackReply: (tenant: TelegramTenant) => string = buildTelegramUnsupportedCallbackReplyImpl;
