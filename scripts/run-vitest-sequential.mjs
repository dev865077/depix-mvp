import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const cliArgs = process.argv.slice(2);
const vitestBin = join(process.cwd(), "node_modules", ".bin", "vitest");

function listTestFiles(directory) {
  return readdirSync(directory)
    .flatMap((entry) => {
      const path = join(directory, entry);
      const stat = statSync(path);

      if (stat.isDirectory()) {
        return listTestFiles(path);
      }

      return path.endsWith(".test.js") ? [path] : [];
    })
    .sort((left, right) => {
      const leftIsDatabaseRepositorySpec = left.endsWith("db.repositories.test.js");
      const rightIsDatabaseRepositorySpec = right.endsWith("db.repositories.test.js");

      if (leftIsDatabaseRepositorySpec !== rightIsDatabaseRepositorySpec) {
        return leftIsDatabaseRepositorySpec ? 1 : -1;
      }

      return left.localeCompare(right);
    });
}

function requiresCloudflarePool(testFile) {
  return readFileSync(testFile, "utf8").includes("cloudflare:test");
}

function runVitest(args, options = {}) {
  const configArgs = options.cloudflare ? [] : ["--config", "vitest.node.config.js"];
  const result = spawnSync(vitestBin, ["--run", ...configArgs, ...args], {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  return result.status ?? 1;
}

if (cliArgs.length > 0) {
  const cloudflare = cliArgs.some((arg) => arg.endsWith(".test.js") && requiresCloudflarePool(join(process.cwd(), arg)));

  process.exit(runVitest(cliArgs, { cloudflare }));
}

for (const testFile of listTestFiles(join(process.cwd(), "test"))) {
  const status = runVitest([relative(process.cwd(), testFile)], {
    cloudflare: requiresCloudflarePool(testFile),
  });

  if (status !== 0) {
    process.exit(status);
  }
}
