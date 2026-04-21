import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const CLOUDFLARE_POOL_MARKER = "@vitest-pool cloudflare";
const CLOUDFLARE_POOL_MARKER_PATTERN = /^\s*\/\/\s*@vitest-pool cloudflare\s*$/mu;
const cliArgs = process.argv.slice(2);
const vitestBin = join(process.cwd(), "node_modules", ".bin", "vitest");

export function listTestFiles(directory) {
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

export function requiresCloudflarePool(testFile) {
  return CLOUDFLARE_POOL_MARKER_PATTERN.test(readFileSync(testFile, "utf8"));
}

export function splitTestFilesByPool(testFiles) {
  return testFiles.reduce((groups, testFile) => {
    if (requiresCloudflarePool(testFile)) {
      groups.cloudflare.push(testFile);
      return groups;
    }

    groups.node.push(testFile);
    return groups;
  }, { node: [], cloudflare: [] });
}

export function splitCliArguments(args) {
  return args.reduce((result, arg) => {
    if (arg.endsWith(".test.js")) {
      result.testFiles.push(arg);
      return result;
    }

    result.passthroughArgs.push(arg);
    return result;
  }, { testFiles: [], passthroughArgs: [] });
}

export function runVitest(args, options = {}) {
  const configArgs = options.cloudflare ? [] : ["--config", "vitest.node.config.js"];
  const result = spawnSync(vitestBin, ["--run", ...configArgs, ...args], {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  return result.status ?? 1;
}

export function runTestFileGroup(testFiles, options = {}, runVitestFn = runVitest) {
  if (testFiles.length === 0) {
    return 0;
  }

  return runVitestFn(testFiles, options);
}

export function main(
  args = cliArgs,
  {
    listTestFilesFn = listTestFiles,
    runVitestFn = runVitest,
  } = {},
) {
  if (args.length > 0) {
    const { testFiles, passthroughArgs } = splitCliArguments(args);
    const absoluteCliTestFiles = testFiles
      .map((arg) => join(process.cwd(), arg));

    if (absoluteCliTestFiles.length === 0) {
      return runVitestFn(args);
    }

    const groupedCliTests = splitTestFilesByPool(absoluteCliTestFiles);
    const nodeArgs = [
      ...passthroughArgs,
      ...groupedCliTests.node.map((testFile) => relative(process.cwd(), testFile)),
    ];
    const cloudflareArgs = [
      ...passthroughArgs,
      ...groupedCliTests.cloudflare.map((testFile) => relative(process.cwd(), testFile)),
    ];

    const nodeStatus = runTestFileGroup(nodeArgs, { cloudflare: false }, runVitestFn);

    if (nodeStatus !== 0) {
      return nodeStatus;
    }

    return runTestFileGroup(cloudflareArgs, { cloudflare: true }, runVitestFn);
  }

  const groupedSuiteTests = splitTestFilesByPool(listTestFilesFn(join(process.cwd(), "test")));
  const nodeSuiteArgs = groupedSuiteTests.node.map((testFile) => relative(process.cwd(), testFile));
  const cloudflareSuiteArgs = groupedSuiteTests.cloudflare.map((testFile) => relative(process.cwd(), testFile));

  const nodeStatus = runTestFileGroup(nodeSuiteArgs, { cloudflare: false }, runVitestFn);

  if (nodeStatus !== 0) {
    return nodeStatus;
  }

  return runTestFileGroup(cloudflareSuiteArgs, { cloudflare: true }, runVitestFn);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
