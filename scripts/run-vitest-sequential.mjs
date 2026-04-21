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

function splitTestFilesByPool(testFiles) {
  return testFiles.reduce((groups, testFile) => {
    if (requiresCloudflarePool(testFile)) {
      groups.cloudflare.push(testFile);
      return groups;
    }

    groups.node.push(testFile);
    return groups;
  }, { node: [], cloudflare: [] });
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

function runTestFileGroup(testFiles, options = {}) {
  if (testFiles.length === 0) {
    return 0;
  }

  return runVitest(testFiles, options);
}

if (cliArgs.length > 0) {
  const absoluteCliTestFiles = cliArgs
    .filter((arg) => arg.endsWith(".test.js"))
    .map((arg) => join(process.cwd(), arg));

  if (absoluteCliTestFiles.length === 0) {
    process.exit(runVitest(cliArgs));
  }

  const groupedCliTests = splitTestFilesByPool(absoluteCliTestFiles);
  const nodeArgs = groupedCliTests.node.map((testFile) => relative(process.cwd(), testFile));
  const cloudflareArgs = groupedCliTests.cloudflare.map((testFile) => relative(process.cwd(), testFile));

  const nodeStatus = runTestFileGroup(nodeArgs, { cloudflare: false });

  if (nodeStatus !== 0) {
    process.exit(nodeStatus);
  }

  process.exit(runTestFileGroup(cloudflareArgs, { cloudflare: true }));
}

const groupedSuiteTests = splitTestFilesByPool(listTestFiles(join(process.cwd(), "test")));
const nodeSuiteArgs = groupedSuiteTests.node.map((testFile) => relative(process.cwd(), testFile));
const cloudflareSuiteArgs = groupedSuiteTests.cloudflare.map((testFile) => relative(process.cwd(), testFile));

const nodeStatus = runTestFileGroup(nodeSuiteArgs, { cloudflare: false });

if (nodeStatus !== 0) {
  process.exit(nodeStatus);
}

process.exit(runTestFileGroup(cloudflareSuiteArgs, { cloudflare: true }));
