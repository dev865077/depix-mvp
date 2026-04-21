import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import ts from "typescript";

describe("bootstrap type boundary", () => {
  it("keeps the worker entrypoint importable while stripping config-module runtime imports from the type layer", async function assertTypeOnlyBoundary() {
    const entrypoint = await import("../src/index.ts");
    const runtimeTypeSource = await readFile(new URL("../src/types/runtime.ts", import.meta.url), "utf8");
    const transpiledRuntimeTypes = ts.transpileModule(runtimeTypeSource, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2023,
      },
      fileName: "src/types/runtime.ts",
    }).outputText;

    expect(entrypoint.default).toBeTruthy();
    expect(transpiledRuntimeTypes).not.toContain("../config/runtime.js");
    expect(transpiledRuntimeTypes).not.toContain("../config/tenants.js");
  });
});
