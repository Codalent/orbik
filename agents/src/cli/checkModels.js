#!/usr/bin/env node

import "dotenv/config";
import process from "node:process";

import { closeMongo, connectMongo } from "@orbik/core";
import { loadExtensions } from "@orbik/extensions";

import { parseAgentEnvironment } from "../config/env.js";
import { createModelCatalogCheck, describeFinding } from "../ai/model/catalogCheck.js";

/**
 * Compares the reasoning provider's model list with the model catalog now, as the scheduler does
 * once a day: which tier's model the provider no longer lists, and which listed model is newer
 * than a tier's model of the same family.
 *
 * It does everything the daily check does (records the result in `system_state`, `_id:
 * "ai-models"`, and tells the extensions `ai.catalog.findings.changed` when the findings differ
 * from the last check's, loading them as `grant:crawl-budget` does) and prints what it found. It
 * needs Anthropic as the provider (`ORBIK_AI_PROVIDER`, or its key alone) and
 * `ORBIK_ANTHROPIC_API_KEY`, read from `agents/.env` like the worker's.
 *
 * Exits 0 when the check was made, findings or not, and 1 when it could not be.
 */
async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.length) throw new Error(`Unknown argument "${args[0]}".\n\n${USAGE}`);

  const config = parseAgentEnvironment(process.env);
  const database = await connectMongo(config);
  try {
    const extensions = await loadExtensions({ processName: "script", specifiers: process.env.ORBIK_EXTENSIONS, database, config });
    const outcome = await createModelCatalogCheck({ database, config, events: extensions, logger: () => {} }).check({ force: true });
    if (outcome.skipped) throw new Error(`Not checked: ${outcome.skipped}`);
    if (outcome.failed) throw new Error(`The provider's model list could not be read: ${outcome.failed}`);

    process.stdout.write(`Checked the ${outcome.provider} model list (${outcome.listed} models) against the model catalog.\n`);
    if (!outcome.findings.length) {
      process.stdout.write("The catalog is up to date: every tier's model is listed, and none is newer in its family.\n");
    } else {
      for (const finding of outcome.findings) process.stdout.write(`- ${describeFinding(finding)}\n`);
      process.stdout.write("Add a newer model with its price to packages/protocol/src/modelCatalog.js and move its tier there.\n");
    }
    process.stdout.write(outcome.changed
      ? "These findings differ from the last check's: recorded, and told to the extensions.\n"
      : "The same as the last check found: recorded.\n");
  } finally {
    await closeMongo();
  }
}

const USAGE = "Usage: pnpm --dir agents run check:models";

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    await closeMongo().catch(() => {});
  }
}
