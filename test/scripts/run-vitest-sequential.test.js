import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  requiresCloudflarePool,
  splitTestFilesByPool,
} from "../../scripts/run-vitest-sequential.mjs";

function createTempTestFile(contents) {
  const directory = mkdtempSync(join(tmpdir(), "run-vitest-sequential-"));
  const file = join(directory, "sample.test.js");
  writeFileSync(file, contents, "utf8");

  return {
    file,
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
});
