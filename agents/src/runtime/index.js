/**
 * Assembles the agent runtime from a connected database and validated configuration.
 *
 * Both long-running entry points (the worker and scheduler processes) and one-shot ones (the CLI)
 * build the runtime through this function, so they cannot drift in how the queue, ledger,
 * registry, dispatcher, and schedulers are wired together.
 */
import { getAgentCollections } from "@orbik/core";

import { createAgentScheduler } from "../ai/agentScheduler.js";
import { createOutboxScheduler } from "../ai/outboxScheduler.js";
import { createRunDispatcher } from "../ai/runDispatcher.js";
import { createCrawlScheduler } from "../crawler/crawlScheduler.js";
import { createLibraryScheduler } from "../library/libraryScheduler.js";
import { createJobQueue } from "./queue.js";
import { createAgentRegistry } from "./registry.js";
import { createRunLedger } from "./runLedger.js";
import { createWorker } from "./worker.js";

/**
 * @param {object} options collaborators
 * @param {import("mongodb").Db} options.database connected MongoDB database
 * @param {object} options.config validated agent environment
 * @param {object[]} options.agents the registered agents this process should execute
 * @param {(level: string, message: string, context?: object) => void} [options.logger]
 * @returns {{queue: object, ledger: object, registry: object, worker: object,
 *   crawlScheduler: object, agentScheduler: object, dispatcher: object, libraryScheduler: object,
 *   outboxScheduler: object}}
 */
export function createRuntime({ database, config, agents, logger }) {
  const collections = getAgentCollections(database);
  const queue = createJobQueue({ jobs: collections.jobs, crawlLocks: collections.crawlLocks });
  const ledger = createRunLedger({ runs: collections.runs });
  const registry = createAgentRegistry(agents);
  const worker = createWorker({ queue, registry, ledger, database, config, logger });
  const crawlScheduler = createCrawlScheduler({
    sites: collections.sites,
    runs: collections.runs,
    queue,
    ledger,
    config,
    logger,
  });
  const agentScheduler = createAgentScheduler({
    schedules: collections.schedules,
    ledger,
    config,
    logger,
  });
  const dispatcher = createRunDispatcher({
    runs: collections.runs,
    queue,
    ledger,
    config,
    logger,
  });
  // The fourth periodic pass, and the Library agent's own. It runs beside the other three rather
  // than being driven by the crawler because the crawler is only one of the things that give the
  // Library work: a file a person edits is a reason to index, and a page somebody asks for by name
  // is a reason to note, and neither has anything to do with a crawl.
  const libraryScheduler = createLibraryScheduler({ database, queue, ledger, config, logger });
  // The fifth, and the outbox's reader: it starts the agents a recorded event gives work to. No
  // agent in this release is one, so its passes find nothing to do. It creates run rows and leaves
  // them to the dispatcher, so it needs the ledger and not the queue.
  const outboxScheduler = createOutboxScheduler({ database, ledger, config, logger });
  return {
    queue, ledger, registry, worker, crawlScheduler, agentScheduler, dispatcher,
    libraryScheduler, outboxScheduler,
  };
}
