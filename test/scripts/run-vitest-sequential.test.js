import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  main,
  requiresCloudflarePool,
  splitCliArguments,
  splitTestFilesByPool,
} from "../../scripts/run-vitest-sequential.mjs";

function createTempTestFile(contents) {
  const directory = mkdtempSync(join(process.cwd(), ".tmp-run-vitest-sequential-"));
  const file = join(directory, "sample.test.js");
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
  it("routes a file to the Cloudflare pool only when the explicit marker is present", () => {
    const markedFile = createTempTestFile("// @vitest-pool cloudflare\nimport { helper } from './helper.js';\n");
    const unmarkedFile = createTempTestFile("import { env } from './indirect-cloudflare-helper.js';\n");

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
    const nodeFile = createTempTestFile("export const runtime = 'node';\n");
    const cloudflareFile = createTempTestFile("// @vitest-pool cloudflare\nexport const runtime = 'worker';\n");
    const calls = [];

    try {
      const status = main(
        ["--reporter=dot", nodeFile.relativeFile, cloudflareFile.relativeFile],
        {
          runVitestFn(args, options) {
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
      splitCliArguments(["--reporter=dot", "--testNamePattern=tenant", "test/runtime-config.test.js"]),
    ).toEqual({
      testFiles: ["test/runtime-config.test.js"],
      passthroughArgs: ["--reporter=dot", "--testNamePattern=tenant"],
    });
  });
});
