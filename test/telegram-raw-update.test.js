/**
 * Testes do parser bruto de updates Telegram.
 */
import { describe, expect, it } from "vitest";

import { extractTelegramRawUpdateMetadata } from "../src/telegram/raw-update.js";

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
});
