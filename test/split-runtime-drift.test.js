import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const activeTargets = [
  ".github",
  "package.json",
  "scripts",
  "src",
  "wrangler.jsonc",
];
const forbiddenActiveRuntimePatterns = [
  /telegram/iu,
  /eulen/iu,
  /financial/iu,
  /deposit/iu,
  /tenant/iu,
  /\bD1\b/u,
  /\bKV(?:Namespace)?\b/u,
  /webhook/iu,
  /\bOPS\b/u,
  /grammy/iu,
  /xstate/iu,
  /lossless/iu,
  /bech32/iu,
];

async function listFiles(targetPath) {
  const absolutePath = join(root, targetPath);
  const targetStat = await stat(absolutePath);

  if (targetStat.isDirectory()) {
    const entries = await readdir(absolutePath, {
      withFileTypes: true,
    });
    const nestedFiles = await Promise.all(entries.map(async (entry) => {
      const nestedPath = join(targetPath, entry.name);

      if (entry.isDirectory()) {
        return listFiles(nestedPath);
      }

      return nestedPath;
    }));

    return nestedFiles.flat();
  }

  return [targetPath];
}

describe("split runtime drift", () => {
  it("keeps depix-mvp free of active mixed-runtime residues", async function assertNoMixedRuntimeResidues() {
    const files = (await Promise.all(activeTargets.map(listFiles))).flat();
    const violations = [];

    for (const file of files) {
      const source = await readFile(join(root, file), "utf8");

      for (const pattern of forbiddenActiveRuntimePatterns) {
        if (pattern.test(source)) {
          violations.push(`${file}: ${pattern}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
