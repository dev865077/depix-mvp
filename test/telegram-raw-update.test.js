/**
 * Testes do parser bruto de updates Telegram.
 */
import { describe, expect, it } from "vitest";

import {
  extractTelegramRawUpdateMetadata,
  parseTelegramRawUpdateEnvelope,
} from "../src/telegram/raw-update.js";

describe("telegram raw update metadata", () => {
  it("preserves large message chat ids without numeric precision loss", function assertLargeMessageChatId() {
    const metadata = extractTelegramRawUpdateMetadata(`{
      "update_id": 1,
      "message": {
        "message_id": 1,
        "chat": {
          "id": 9007199254740993123,
          "type": "private"
        }
      }
    }`);

    expect(metadata.parseFailed).toBe(false);
    expect(metadata.chatId).toBe("9007199254740993123");
  });

  it("extracts callback query message chat ids for future non-message routing", function assertCallbackQueryChatId() {
    const metadata = extractTelegramRawUpdateMetadata(`{
      "update_id": 2,
      "callback_query": {
        "id": "callback-2",
        "message": {
          "message_id": 2,
          "chat": {
            "id": 9007199254740993999,
            "type": "private"
          }
        }
      }
    }`);

    expect(metadata.parseFailed).toBe(false);
    expect(metadata.chatId).toBe("9007199254740993999");
  });

  it("builds an explicit normalized contract for supported text updates", function assertNormalizedTelegramUpdateContract() {
    const parsed = parseTelegramRawUpdateEnvelope(`{
      "update_id": 3,
      "message": {
        "message_id": 9,
        "date": 1713434400,
        "text": "/start",
        "chat": {
          "id": 9007199254740993555,
          "type": "private"
        },
        "from": {
          "id": 501,
          "is_bot": false,
          "first_name": "Pedro"
        }
      }
    }`);

    expect(parsed.metadata.parseFailed).toBe(false);
    expect(parsed.normalizedUpdate).toEqual({
      updateKind: "message",
      rawUpdateType: "message",
      chatId: "9007199254740993555",
      fromId: "501",
      text: "/start",
      command: "/start",
      hasReplyChannel: true,
    });
  });

  it("marks inline queries as unsupported updates without a reply surface", function assertUnsupportedInlineQueryContract() {
    const parsed = parseTelegramRawUpdateEnvelope(`{
      "update_id": 4,
      "inline_query": {
        "id": "inline-4",
        "from": {
          "id": 777,
          "is_bot": false,
          "first_name": "Pedro"
        },
        "query": "noop",
        "offset": ""
      }
    }`);

    expect(parsed.normalizedUpdate).toEqual({
      updateKind: "unsupported",
      rawUpdateType: "inline_query",
      fromId: "777",
      hasReplyChannel: false,
    });
  });
});
