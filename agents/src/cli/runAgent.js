import "dotenv/config";

import { closeMongo, connectMongo, log } from "@orbik/core";
import { ObjectId } from "mongodb";

import { createAgents } from "../registeredAgents.js";
import { ensureAgentIndexes } from "../db/indexes.js";
import { parseAgentEnvironment } from "../config/env.js";
import { createRuntime } from "../runtime/index.js";
import { RUN_STATUS } from "../runtime/runLedger.js";

const USAGE = `Usage: pnpm --dir agents agent:run -- --agent <name> --type <job.type> [options]

Options:
  --agent <name>        Registered agent to execute (required)
  --type <job.type>     Job type within that agent (required)
  --site <objectId>     Site the run belongs to
  --workspace <id>      Owning workspace
  --payload <json>      JSON object passed to the handler (default: {})
  --wait                Execute the run to completion in this process instead of only queueing it
`;

/**
 * Runs one agent once, for development and operational spot-checks.
 *
 * Without `--wait` the command only queues the work, which is the safe default: it exercises the
 * same queue path production uses instead of a special-cased in-process shortcut that could
 * succeed where the real path fails. With `--wait` it also runs an embedded worker until the
 * run's jobs drain, which is what makes the command useful before a worker is deployed.
 */
async function main(argv) {
  const options = parseArguments(argv);
  const config = parseAgentEnvironment(process.env);
  const database = await connectMongo(config);
  await ensureAgentIndexes(database);

  const { queue, ledger, registry, worker } = createRuntime({
    database,
    config,
    agents: createAgents({ config, database, logger: log }),
  });

  const definition = registry.find(options.agent);
  if (!definition) {
    throw new Error(`Unknown agent "${options.agent}". Registered: ${registry.names().join(", ") || "none"}.`);
  }
  if (!definition.handlers[options.type]) {
    throw new Error(
      `Agent "${options.agent}" has no job type "${options.type}". Available: ${Object.keys(definition.handlers).join(", ")}.`,
    );
  }

  const run = await ledger.start({
    agent: definition.name,
    version: definition.version,
    trigger: "manual",
    siteId: options.siteId,
    workspaceId: options.workspaceId,
    config: options.payload,
  });

  await queue.enqueue({
    agent: options.agent,
    type: options.type,
    payload: options.payload,
    runId: run._id,
    siteId: options.siteId,
    workspaceId: options.workspaceId,
    priority: 0,
    idempotencyKey: `manual:${run._id.toHexString()}`,
  });

  log("info", "agent.run_queued", { runId: run._id.toHexString(), agent: options.agent, type: options.type });

  if (!options.wait) {
    await closeMongo();
    return;
  }

  const stopWhenDrained = pollUntilDrained({ queue, runId: run._id, worker });
  await worker.start();
  await stopWhenDrained;

  const counts = await queue.countByStatus(run._id);
  const failed = counts.failed ?? 0;
  await ledger.finish(
    run._id,
    failed ? RUN_STATUS.failed : RUN_STATUS.succeeded,
    failed ? { error: { code: "JOBS_FAILED", message: `${failed} job(s) were dead-lettered.` } } : {},
  );
  log("info", "agent.run_finished", { runId: run._id.toHexString(), ...counts });
  await closeMongo();
  if (failed) process.exitCode = 1;
}

/**
 * Stops the embedded worker once the run has no pending or running jobs left.
 *
 * Polling the queue rather than counting handler completions is what makes this correct for
 * agents that fan out: the crawler enqueues follow-up jobs from inside its own handlers, so the
 * run is only over when the queue says so.
 */
function pollUntilDrained({ queue, runId, worker, intervalMs = 250 }) {
  return new Promise((resolve, reject) => {
    const timer = setInterval(async () => {
      try {
        const counts = await queue.countByStatus(runId);
        if ((counts.pending ?? 0) + (counts.running ?? 0) > 0) return;
        clearInterval(timer);
        await worker.stop();
        resolve();
      } catch (error) {
        clearInterval(timer);
        reject(error);
      }
    }, intervalMs);
  });
}

/**
 * Parses and validates command-line arguments.
 *
 * Command-line input is untrusted like any other ingress: an unparseable payload or a malformed
 * identifier is rejected here, before it can be persisted into a job or reach a handler.
 *
 * @param {string[]} argv arguments after the script name
 * @returns {{agent: string, type: string, siteId?: string, workspaceId?: string, payload: object, wait: boolean}}
 * @throws {Error} with usage text when any argument is missing or malformed
 */
function parseArguments(argv) {
  const values = { payload: "{}", wait: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--wait") {
      values.wait = true;
      continue;
    }
    const name = { "--agent": "agent", "--type": "type", "--site": "site", "--workspace": "workspace", "--payload": "payload" }[argument];
    if (!name) throw new Error(`Unknown argument "${argument}".\n\n${USAGE}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value.\n\n${USAGE}`);
    values[name] = value;
    index += 1;
  }

  if (!values.agent || !values.type) throw new Error(`--agent and --type are required.\n\n${USAGE}`);
  for (const [flag, value] of [["--site", values.site], ["--workspace", values.workspace]]) {
    if (value !== undefined && !ObjectId.isValid(value)) {
      throw new Error(`${flag} must be a MongoDB ObjectId.\n\n${USAGE}`);
    }
  }

  let payload;
  try {
    payload = JSON.parse(values.payload);
  } catch {
    throw new Error(`--payload must be valid JSON.\n\n${USAGE}`);
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`--payload must be a JSON object.\n\n${USAGE}`);
  }

  return {
    agent: values.agent,
    type: values.type,
    siteId: values.site,
    workspaceId: values.workspace,
    payload,
    wait: values.wait,
  };
}

// Only run when invoked directly, not when the module is imported.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    log("error", "agent.run_failed", { message: error.message });
    process.exitCode = 64;
    await closeMongo().catch(() => {});
  }
}
