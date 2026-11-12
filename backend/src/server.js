import "dotenv/config";

import { fileURLToPath } from "node:url";

import { closeMongo, connectMongo, isMongoReady, log } from "@orbik/core";
import { extendAgentCatalog } from "@orbik/agent-definitions";
import { loadExtensions } from "@orbik/extensions";
import { runMigrations } from "@orbik/migrations";

import { createApp } from "./app.js";
import { parseEnvironment } from "./config/env.js";
import { resolveSecrets } from "./config/secrets.js";
import { ensureIndexes } from "./db/indexes.js";
import { prepareFirstRun, setupBanner } from "./services/setupService.js";

const parsed = parseEnvironment(process.env);
const database = await connectMongo(parsed);
await ensureIndexes(database);
// What an upgrade changed in the stored data, done before the first request reads it. The worker
// and the scheduler run the same list; whichever starts first does the work.
await runMigrations({ database, logger: log });
const config = await resolveSecrets(parsed, database);
// Before the first request: a deployment configured with extensions that enforce its plans must
// not serve one request without them. With ORBIK_EXTENSIONS unset there are none.
const extensions = await loadExtensions({
  processName: "api",
  specifiers: process.env.ORBIK_EXTENSIONS,
  database,
  config,
  logger: log,
});
// The agents and tools extensions added join the catalog before anything reads it; a definition
// that does not check out stops the process here, as a failed extension does.
extendAgentCatalog({ definitions: extensions.agentDefinitions, tools: extensions.tools });

// devbar, when ORBIK_DEVBAR is on: its items are Markdown files in the repository's .devbar/.
// Imported only then, so a deployment without it needs nothing of it.
const devbar = config.devbar
  ? await (await import("@codalent/devbar/server")).createDevbar({
    dir: fileURLToPath(new URL("../../.devbar", import.meta.url)),
    key: config.devbarKey,
    log: (line) => log("info", "devbar", { change: line.trim() }),
  })
  : null;

const app = createApp({ config, database, readiness: () => isMongoReady(database), extensions, devbar });
const server = app.listen(config.port, config.host, () => {
  log("info", "API listening", { host: config.host, port: config.port });
});

// A new install says how to claim it, in words, where its operator will look: this process's log.
const setupCode = await prepareFirstRun(database);
if (setupCode) {
  console.log(setupBanner({ code: setupCode, url: `${config.frontendOrigins[0]}/setup` }));
}

/**
 * Stops accepting traffic, closes MongoDB, and then exits — always.
 *
 * Exiting is explicit rather than left to an empty event loop. Something in a running API always
 * holds the loop open — a keep-alive connection from a browser tab that is polling, a heartbeat
 * interval, a session store's timer — and a process that has closed its listener but not exited
 * is the worst of both: `node --watch` waits for it forever and never starts the replacement, and
 * PM2 counts down and kills it. So the sequence is: stop listening, let
 * in-flight requests finish, close MongoDB, exit. A hard deadline covers the case where any step
 * hangs.
 */
function shutdown(signal) {
  log("info", "API shutdown requested", { signal });
  const deadline = setTimeout(() => {
    log("warn", "API shutdown forced", { signal });
    process.exit(1);
  }, 12_000);
  deadline.unref();

  server.close(async () => {
    await closeMongo().catch((error) => {
      log("error", "mongo.shutdown_failed", { message: error.message });
    });
    process.exit(0);
  });
  // Idle keep-alive connections would otherwise hold `close` open until they time out.
  setTimeout(() => server.closeAllConnections(), 3_000).unref();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
