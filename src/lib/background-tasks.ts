/**
 * Helpers para side effects em background.
 *
 * O Worker responde pelo resultado principal da requisicao. Side effects como
 * notificacao Telegram devem sair do caminho critico sempre que o
 * `ExecutionContext` estiver disponivel. Em execucao local sem `waitUntil`, o
 * helper cai para `await` explicito para manter testes deterministas.
 */
import type { Context } from "hono";

/**
 * Despacha uma tarefa sem transformar o side effect em dependencia obrigatoria
 * do response HTTP.
 *
 * @param {import("hono").Context} context Contexto atual da borda HTTP.
 * @param {Promise<unknown>} task Promessa do side effect ja criada.
 * @returns {Promise<void>} Resolve quando o despacho seguro terminar.
 */
export async function dispatchNonBlockingTask(context: Context, task: Promise<unknown>): Promise<void> {
  let executionCtx = null;

  try {
    executionCtx = context.executionCtx;
  } catch {
    executionCtx = null;
  }

  if (executionCtx && typeof executionCtx.waitUntil === "function") {
    executionCtx.waitUntil(task);
    return;
  }

  await task;
}
