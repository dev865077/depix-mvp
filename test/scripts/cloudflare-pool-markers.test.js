import { join } from "node:path";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CLOUDFLARE_POOL_MARKER,
  listTestFiles,
  requiresCloudflarePool,
} from "../../scripts/run-vitest-sequential.mjs";

const CLOUDFLARE_IMPORT_PATTERN = /from\s+["']cloudflare:test["']/;

describe("Cloudflare pool marker coverage", () => {
  it("marks every Cloudflare spec in the repository with the explicit runner marker", () => {
    const cloudflareSpecs = listTestFiles(join(process.cwd(), "test"))
      .filter((testFile) => CLOUDFLARE_IMPORT_PATTERN.test(readFileSync(testFile, "utf8")));

    expect(cloudflareSpecs.length).toBeGreaterThan(0);
    expect(
      cloudflareSpecs.map((testFile) => ({
        testFile,
        hasMarker: requiresCloudflarePool(testFile),
      })),
    ).toEqual(
      cloudflareSpecs.map((testFile) => ({
        testFile,
        hasMarker: true,
      })),
    );
  });

  it("uses a single canonical marker string for repo-wide Cloudflare coverage", () => {
    expect(CLOUDFLARE_POOL_MARKER).toBe("@vitest-pool cloudflare");
  });
});
