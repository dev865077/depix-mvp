import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

async function listSourceFiles(directory) {
  const entries = await readdir(directory, {
    withFileTypes: true,
  });
  const files = await Promise.all(entries.map(async (entry) => {
    const targetPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      return listSourceFiles(targetPath);
    }

    return targetPath;
  }));

  return files.flat();
}

describe("typescript runtime cleanup", () => {
  it("keeps package entrypoint aligned with the TypeScript worker entrypoint", async function assertPackageMain() {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

    expect(packageJson.main).toBe("src/index.ts");
  });

  it("does not keep duplicate .js/.ts runtime pairs under src", async function assertNoDuplicateRuntimePairs() {
    const sourceFiles = await listSourceFiles(fileURLToPath(new URL("../src", import.meta.url)));
    const sourceFileSet = new Set(sourceFiles);
    const duplicatePairs = sourceFiles
      .filter((file) => file.endsWith(".ts"))
      .map((file) => [file.replace(/\.ts$/, ".js"), file])
      .filter(([jsFile]) => sourceFileSet.has(jsFile))
      .map(([jsFile, tsFile]) => `${jsFile} <-> ${tsFile}`);

    expect(duplicatePairs).toEqual([]);
  });
});
