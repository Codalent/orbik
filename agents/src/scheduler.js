import "dotenv/config";

import { closeMongo, connectMongo, log } from "@orbik/core";
import { extendAgentCatalog } from "@orbik/agent-definitions";
import { loadExtensions } from "@orbik/extensions";
import { runMigrations } from "@orbik/migrations";

import { createAgents } from "./registeredAgents.js";
import { ensureAgentIndexes } from "./db/indexes.js";
import { parseAgentEnvironment } from "./config/env.js";
import { createRuntime } from "./runtime/index.js";
import { createTelemetry } from "./telemetry.js";

/**
 * Long-running scheduler.
 *
 * Separate from the worker process so that scheduling survives a worker being restarted, scaled,
 * or crashed by a bad page, and so the two can be sized independently: one scheduler is enough for
 * any number of sites, while workers scale with crawl volume.
 *
 * Running more than one is safe — sites, schedules, and runs are all claimed atomically — but
 * unnecessary.
 *
 * Five loops share this process because all five are the same kind of work: a short periodic
 * pass that notices something due and turns it into queued work. They run concurrently rather than
 * in sequence so a slow scheduling pass cannot delay dispatch — a user who clicks Run should not
 * wait on a crawl schedule that happens to be mid-tick, and neither should a workspace whose
 * Library is waiting to be mirrored, indexed or rewritten.
 */
const config = parseAgentEnvironment(process.env);
const database = await connectMongo(config);
await ensureAgentIndexes(database);
await runMigrations({ database, logger: log });
const extensions = await loadExtensions({
  processName: "scheduler",
  specifiers: process.env.ORBIK_EXTENSIONS,
  database,
  config,
  logger: log,
});
// The agents and tools extensions added join the catalog before anything reads it; a definition
// that does not check out stops the process here, as a failed extension does.
extendAgentCatalog({ definitions: extensions.agentDefinitions, tools: extensions.tools });

const {
  crawlScheduler, agentScheduler, dispatcher, libraryScheduler, outboxScheduler,
} = createRuntime({
  database,
  config,
  agents: createAgents({ config, database, logger: log, extensions }),
});

// The anonymous daily usage ping, only with ORBIK_TELEMETRY=on; what it sends is said here, in the
// log, before anything is sent.
const telemetry = createTelemetry({ database, config, extensions, logger: log });
telemetry.announce();

// An extension's loops start and stop with the core ones.
const loops = [
  crawlScheduler, agentScheduler, dispatcher, libraryScheduler, outboxScheduler,
  ...(telemetry.loop ? [telemetry.loop] : []),
  ...extensions.loops,
];

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    Promise.all(loops.map((loop) => loop.stop()))
      .then(() => closeMongo())
      .then(() => process.exit(0))
      .catch((error) => {
        log("error", "scheduler.shutdown_failed", { message: error.message });
        process.exit(1);
      });
  });
}

await Promise.all(loops.map((loop) => loop.start()));
