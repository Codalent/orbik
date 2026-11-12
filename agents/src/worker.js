import "dotenv/config";

import { closeMongo, connectMongo, log } from "@orbik/core";
import { extendAgentCatalog } from "@orbik/agent-definitions";
import { loadExtensions } from "@orbik/extensions";
import { runMigrations } from "@orbik/migrations";

import { createAgents } from "./registeredAgents.js";
import { ensureAgentIndexes } from "./db/indexes.js";
import { retireBrandGuides } from "./library/retireBrandGuides.js";
import { parseAgentEnvironment } from "./config/env.js";
import { createRuntime } from "./runtime/index.js";

/**
 * Long-running agent worker.
 *
 * Deliberately binds no port. The API on 4100 remains the only HTTP listener in the system, and
 * run progress is observed by reading MongoDB, so any number of workers can run on a host
 * without port coordination.
 */
const config = parseAgentEnvironment(process.env);
// Which provider the reasoning calls go to, and whether its key is set: never the key itself.
log(config.aiProviderConfigured ? "info" : "warn", "ai.provider", { provider: config.aiProvider, configured: config.aiProviderConfigured });
const database = await connectMongo(config);
await ensureAgentIndexes(database);
// Before the first job is claimed; the API and the scheduler run the same list.
await runMigrations({ database, logger: log });
await retireBrandGuides(database);
// Before any job is claimed: a deployment's plan limits must be in force for the first page it
// charges. With ORBIK_EXTENSIONS unset there are none, and nothing is limited.
const extensions = await loadExtensions({
  processName: "worker",
  specifiers: process.env.ORBIK_EXTENSIONS,
  database,
  config,
  logger: log,
});
// The agents and tools extensions added join the catalog before anything reads it; a definition
// that does not check out stops the process here, as a failed extension does.
extendAgentCatalog({ definitions: extensions.agentDefinitions, tools: extensions.tools });

const { worker } = createRuntime({
  database,
  config,
  agents: createAgents({ config, database, logger: log, extensions }),
});

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    // A second signal during a graceful stop means the operator wants out now; honouring the
    // first one twice would restart the grace period instead of shortening it.
    if (stopping) process.exit(1);
    stopping = true;
    worker
      .stop()
      .then(() => closeMongo())
      .then(() => process.exit(0))
      .catch((error) => {
        log("error", "agent.shutdown_failed", { message: error.message });
        process.exit(1);
      });
  });
}

await worker.start();
