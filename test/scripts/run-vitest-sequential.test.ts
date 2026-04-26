import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isTestFile,
  listTestFiles,
  main,
  requiresCloudflarePool,
  splitCliArguments,
  splitTestFilesByPool,
} from "../../scripts/run-vitest-sequential.mjs";

type TempTestFile = {
  file: string;
  relativeFile: string;
  cleanup: () => void;
};

type RunCall = {
  args: string[];
  options: {
    cloudflare?: boolean;
  };
};

function createTempTestFile(contents: string, extension = ".test.js"): TempTestFile {
  const directory = mkdtempSync(join(process.cwd(), ".tmp-run-vitest-sequential-"));
  const file = join(directory, `sample${extension}`);
  writeFileSync(file, contents, "utf8");

  return {
    file,
    relativeFile: relative(process.cwd(), file),
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("run-vitest-sequential", () => {
  it("recognizes JavaScript and TypeScript Vitest specs", () => {
    expect(isTestFile("test/runtime-config.test.js")).toBe(true);
    expect(isTestFile("test/scripts/run-vitest-sequential.test.ts")).toBe(true);
    expect(isTestFile("test/helpers/database-schema.js")).toBe(false);
  });

  it("discovers JavaScript and TypeScript specs when walking the suite", () => {
    const directory = mkdtempSync(join(process.cwd(), ".tmp-run-vitest-sequential-"));
    const jsFile = join(directory, "alpha.test.js");
    const tsFile = join(directory, "beta.test.ts");
    const helperFile = join(directory, "helper.ts");

    try {
      writeFileSync(jsFile, "export const runtime = 'node';\n", "utf8");
      writeFileSync(tsFile, "export const runtime: 'node' = 'node';\n", "utf8");
      writeFileSync(helperFile, "export const helper = true;\n", "utf8");

      expect(listTestFiles(directory)).toEqual([jsFile, tsFile]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("routes a file to the Cloudflare pool only when the explicit marker is present", () => {
    const markedFile = createTempTestFile("// @vitest-pool cloudflare\nimport { helper } from './helper.js';\n");
    const unmarkedFile = createTempTestFile("import { env } from './indirect-cloudflare-helper.js';\n", ".test.ts");

    try {
      expect(requiresCloudflarePool(markedFile.file)).toBe(true);
      expect(requiresCloudflarePool(unmarkedFile.file)).toBe(false);
    } finally {
      markedFile.cleanup();
      unmarkedFile.cleanup();
    }
  });

  it("splits node and Cloudflare specs by the explicit marker", () => {
    const markedFile = createTempTestFile("// @vitest-pool cloudflare\nexport const runtime = 'worker';\n");
    const unmarkedFile = createTempTestFile("export const runtime = 'node';\n");

    try {
      expect(splitTestFilesByPool([markedFile.file, unmarkedFile.file])).toEqual({
        node: [unmarkedFile.file],
        cloudflare: [markedFile.file],
      });
    } finally {
      markedFile.cleanup();
      unmarkedFile.cleanup();
    }
  });

  it("preserves non-file Vitest CLI args when splitting test files by pool", () => {
    const nodeFile = createTempTestFile("export const runtime: 'node' = 'node';\n", ".test.ts");
    const cloudflareFile = createTempTestFile("// @vitest-pool cloudflare\nexport const runtime = 'worker';\n");
    const calls: RunCall[] = [];

    try {
      const status = main(
        ["--reporter=dot", nodeFile.relativeFile, cloudflareFile.relativeFile],
        {
          runVitestFn(args: string[], options: RunCall["options"]) {
            calls.push({ args, options });
            return 0;
          },
        },
      );

      expect(status).toBe(0);
      expect(calls).toEqual([
        {
          args: ["--reporter=dot", nodeFile.relativeFile],
          options: { cloudflare: false },
        },
        {
          args: ["--reporter=dot", cloudflareFile.relativeFile],
          options: { cloudflare: true },
        },
      ]);
    } finally {
      nodeFile.cleanup();
      cloudflareFile.cleanup();
    }
  });

  it("separates passthrough args from test file args", () => {
    expect(
      splitCliArguments(["--reporter=dot", "--testNamePattern=runtime", "test/runtime-config.test.js"]),
    ).toEqual({
      testFiles: ["test/runtime-config.test.js"],
      passthroughArgs: ["--reporter=dot", "--testNamePattern=runtime"],
    });
  });

  it("separates TypeScript test file args from passthrough args", () => {
    expect(
      splitCliArguments(["--reporter=dot", "test/scripts/run-vitest-sequential.test.ts"]),
    ).toEqual({
      testFiles: ["test/scripts/run-vitest-sequential.test.ts"],
      passthroughArgs: ["--reporter=dot"],
    });
  });
});
