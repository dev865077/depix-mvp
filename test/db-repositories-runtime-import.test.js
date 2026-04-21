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
  const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "-e", command, specifier], {
    cwd: process.cwd(),
  });

  expect(stdout.trim()).toBe("ok");
}

describe("db repository runtime imports", () => {
  it("keeps the D1 boundary loadable from plain node", async function assertDbRuntimeImports() {
    await assertNodeImport("./src/db/client.js");
    await assertNodeImport("./src/db/repositories/orders-repository.js");
    await assertNodeImport("./src/db/repositories/deposits-repository.js");
    await assertNodeImport("./src/db/repositories/deposit-events-repository.js");
  });
});
