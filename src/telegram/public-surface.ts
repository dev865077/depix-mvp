export type TelegramPublicCommandRole = "usuário" | "operador" | "ambos";

type TelegramPublicCommandDefinition = Readonly<{
  command: string;
  description: string;
  role: TelegramPublicCommandRole;
}>;

type TelegramPublicRename = Readonly<{
  previous: string;
  current: string;
  note: string;
}>;

type TelegramPublicRemoval = Readonly<{
  command: string;
  note: string;
}>;

type TelegramBotCommandResponseItem = {
  command?: unknown;
  description?: unknown;
};

type TelegramMenuButtonResponse = {
  type?: unknown;
  text?: unknown;
  url?: unknown;
};

export const TELEGRAM_ALLOWED_UPDATES = Object.freeze([
  "message",
  "callback_query",
]);

export const TELEGRAM_PUBLIC_COMMANDS = Object.freeze<TelegramPublicCommandDefinition[]>([
  {
    command: "start",
    description: "Começar uma compra",
    role: "usuário",
  },
  {
    command: "help",
    description: "Ver ajuda do fluxo",
    role: "ambos",
  },
  {
    command: "status",
    description: "Ver pedido atual",
    role: "usuário",
  },
  {
    command: "cancel",
    description: "Cancelar pedido aberto",
    role: "usuário",
  },
]);

export const TELEGRAM_PUBLIC_RENAMES = Object.freeze<TelegramPublicRename[]>([
  {
    previous: "/iniciar",
    current: "/start",
    note: "Alias legado suprimido da superfície pública; o runtime ainda aceita a forma antiga por compatibilidade.",
  },
]);

export const TELEGRAM_PUBLIC_REMOVALS = Object.freeze<TelegramPublicRemoval[]>([]);

export function buildTelegramPublicCommandsPayload() {
  return TELEGRAM_PUBLIC_COMMANDS.map(function toTelegramCommand(command) {
    return {
      command: command.command,
      description: command.description,
    };
  });
}

export function buildTelegramPublicMenuButtonPayload() {
  return {
    type: "commands",
  };
}

export function buildTelegramPublicSurfaceInventory() {
  return {
    maintained: TELEGRAM_PUBLIC_COMMANDS.map(function toMaintainedItem(command) {
      return {
        command: `/${command.command}`,
        role: command.role,
        description: command.description,
      };
    }),
    removed: TELEGRAM_PUBLIC_REMOVALS,
    renamed: TELEGRAM_PUBLIC_RENAMES,
  };
}

export function summarizeTelegramCommandsResponse(responseBody: { result?: unknown } | null | undefined) {
  const result = Array.isArray(responseBody?.result)
    ? responseBody.result
    : [];

  return result
    .filter(function isCommandEntry(entry): entry is TelegramBotCommandResponseItem {
      return Boolean(entry) && typeof entry === "object";
    })
    .filter(function hasCommandShape(entry) {
      return typeof entry.command === "string" && typeof entry.description === "string";
    })
    .map(function toCommandSummary(entry) {
      return {
        command: entry.command,
        description: entry.description,
      };
    });
}

export function summarizeTelegramMenuButtonResponse(responseBody: { result?: unknown } | null | undefined) {
  const result = responseBody?.result;

  if (!result || typeof result !== "object") {
    return null;
  }

  const typedResult = result as TelegramMenuButtonResponse;

  if (typeof typedResult.type !== "string") {
    return null;
  }

  return {
    type: typedResult.type,
    text: typeof typedResult.text === "string" ? typedResult.text : null,
    url: typeof typedResult.url === "string" ? typedResult.url : null,
  };
}
