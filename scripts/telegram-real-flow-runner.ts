#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import {
  buildAbortedRealRunReport,
  buildOperatorInstructions,
  buildRealRunReport,
  extractTailLogRecords,
  readTelegramRealRunOptions,
  startWranglerTail,
  writeJsonArtifact,
} from "./lib/telegram-real-flow.js";

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runObservedRealFlow(argv: string[], cwd: string): Promise<number> {
  const options = readTelegramRealRunOptions(argv);

  if (!options.confirmReal) {
    const report = buildAbortedRealRunReport(options);

    await writeJsonArtifact(options.outputPath, report);
    process.stderr.write(`Real execution blocked: pass --confirm-real only for an operator-assisted paid test. Evidence: ${options.outputPath}\n`);
    return 2;
  }

  process.stdout.write(`${buildOperatorInstructions(options)}\n`);

  const tail = startWranglerTail({ environment: options.environment, cwd });
  let stdout = "";
  let stderr = "";

  tail.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  tail.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const startedAt = Date.now();

  while (Date.now() - startedAt < options.timeoutMs) {
    await wait(1000);
    const records = extractTailLogRecords(stdout);
    const report = buildRealRunReport(options, records);

    if (report.status === "success") {
      tail.kill();
      await writeJsonArtifact(options.outputPath, {
        ...report,
        tailStderr: stderr.trim() || null,
      });
      process.stdout.write(`Telegram real-flow run passed. Evidence: ${options.outputPath}\n`);
      return 0;
    }
  }

  tail.kill();

  const report = buildRealRunReport(options, extractTailLogRecords(stdout));

  await writeJsonArtifact(options.outputPath, {
    ...report,
    status: "failure",
    timeoutMs: options.timeoutMs,
    tailStderr: stderr.trim() || null,
  });
  process.stderr.write(`Telegram real-flow run failed or timed out. Evidence: ${options.outputPath}\n`);
  return 1;
}

function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  process.exitCode = await runObservedRealFlow(process.argv.slice(2), process.cwd());
}

export { runObservedRealFlow as runTelegramRealFlowRunnerCli };

