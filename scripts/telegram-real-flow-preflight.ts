#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import {
  buildEulenWebhookUrl,
  evaluateTelegramPreflight,
  fetchJson,
  readTelegramPreflightOptions,
  writeJsonArtifact,
} from "./lib/telegram-real-flow.js";

async function main(argv: string[]): Promise<number> {
  const options = readTelegramPreflightOptions(argv, process.env);
  const healthUrl = `${options.publicBaseUrl}/health`;
  const webhookInfoUrl = `${options.publicBaseUrl}/ops/${options.tenantId}/telegram/webhook-info?publicBaseUrl=${encodeURIComponent(options.publicBaseUrl)}`;
  const healthResult = await fetchJson({ fetchFn: fetch, url: healthUrl });
  const webhookInfoResult = options.opsBearerToken
    ? await fetchJson({
      fetchFn: fetch,
      url: webhookInfoUrl,
      headers: {
        authorization: `Bearer ${options.opsBearerToken}`,
      },
    })
    : { body: null, error: "missing_ops_bearer_token" };
  const report = evaluateTelegramPreflight({
    options,
    health: healthResult.body,
    healthError: healthResult.error,
    webhookInfo: webhookInfoResult.body,
    webhookInfoError: webhookInfoResult.error,
  });

  await writeJsonArtifact(options.outputPath, {
    ...report,
    eulenWebhookUrl: buildEulenWebhookUrl(options.environment, options.tenantId),
    issueNumber: options.issueNumber,
  });

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (report.status !== "success") {
    process.stderr.write(`Telegram real-flow preflight failed. Evidence: ${options.outputPath}\n`);
    return 1;
  }

  process.stdout.write(`Telegram real-flow preflight passed. Evidence: ${options.outputPath}\n`);
  return 0;
}

function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  process.exitCode = await main(process.argv.slice(2));
}

export { main as runTelegramRealFlowPreflightCli };

