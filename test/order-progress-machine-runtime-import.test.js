import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

async function assertNodeImport(specifier) {
  const command = [
    "import(process.argv[1])",
    ".then(() => console.log('ok'))",
    ".catch((error) => {",
    "console.error(error);",
    "process.exit(1);",
    "});",
  ].join("");
  const { stdout } = await execFileAsync(process.execPath, ["-e", command, specifier], {
    cwd: process.cwd(),
  });

  expect(stdout.trim()).toBe("ok");
}

describe("order progress machine runtime imports", () => {
  it("keeps the machine entrypoint loadable from plain node", async function assertMachineRuntimeImport() {
    await assertNodeImport("./src/order-flow/order-progress-machine.js");
  });

  it("keeps JS consumers loadable without a TypeScript loader", async function assertRuntimeJsConsumers() {
    await assertNodeImport("./src/services/order-registration.js");
    await assertNodeImport("./src/services/telegram-order-confirmation.js");
    await assertNodeImport("./src/telegram/reply-flow.js");
  });
});
