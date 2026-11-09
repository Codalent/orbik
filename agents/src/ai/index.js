import { RUNTIME_REQUIREMENTS } from "@orbik/protocol";

import { AI_AGENT, AI_JOBS } from "../jobs.js";
import { defineAgent } from "../runtime/registry.js";
import { createDesignSystemRuntime } from "./designSystem/runtime.js";
import { createModelRuntime } from "./model/modelRuntime.js";
import { createModelRouter } from "./model/modelRouter.js";
import { createProviders } from "./model/providers/index.js";
import { createShortTextWriter } from "./model/shortText.js";
import { createStructuredWriter } from "./model/structured.js";
import { createExecuteRunHandler } from "./executeRun.js";

/**
 * The agent that runs every other agent.
 *
 * From the queue's point of view this is one more registered agent with one handler, which is why
 * it gets leases, retries, backoff, heartbeats, and crash recovery without any of that being
 * rebuilt for AI work. From the product's point of view it is the execution engine: the thing that
 * takes "run business-knowledge-base v4 for this workspace" and makes it happen.
 *
 * The providers it can reach are decided here, once, from configuration. A deployment with no
 * provider credentials still registers the agent — it simply cannot route any capability, and says
 * so clearly on the first run rather than failing somewhere deeper.
 *
 * @param {object} options collaborators
 * @param {object} options.config validated agent environment
 * @param {import("mongodb").Db} options.database connected database
 * @param {(level: string, message: string, context?: object) => void} options.logger
 * @param {{model: object, plain: Record<string, object>}} [options.runtimes] the runtimes runs
 *   execute in; defaults to the ones this worker's configuration can build
 * @param {object} [options.callLog] the AI call log every model call is reported to
 * @param {object|null} [options.retrieval] the retrieval index `content.search` queries; a worker
 *   without one still runs every agent, and the search tool refuses with a reason
 * @param {{code: string, message: string}|null} [options.retrievalReason] why there is no index,
 *   for a plain-code runtime that cannot work without it and has to say why
 */
export function createAiAgent({ config, database, logger, runtimes, callLog = null, retrieval = null, retrievalReason = null }) {
  return defineAgent({
    name: AI_AGENT,
    version: 1,
    handlers: {
      [AI_JOBS.execute]: createExecuteRunHandler({
        runtimes: runtimes ?? buildRuntimes({ config, database, logger, callLog, retrieval, retrievalReason }),
        retrieval,
      }),
    },
  });
}

/**
 * The plain-code runtimes: the ones that execute a definition themselves, with no model deciding
 * what happens.
 *
 * Keyed by the runtime requirement a definition names (`RUNTIME_REQUIREMENTS` in
 * `@orbik/protocol`), and that key is the whole of the wiring: the run handler sends a definition
 * to the runtime its requirements name and everything else to the model. **Adding a plain-code
 * agent is one entry here** — a requirement and how to build what executes it — beside its
 * definition; nothing in the run handler changes.
 *
 * They live under the `ai` agent because each is dispatched, leased, retried, and recorded exactly
 * like a model run, and a second queue for them would be a second copy of all of that.
 *
 * Each builder is handed the same collaborators and takes what it needs: the validated `config`,
 * the `database`, the `logger`, the retrieval index (`retrieval`, or null with `retrievalReason`
 * saying why), and the two ways plain code asks a model for something —
 * `writeText` for a short piece of prose (`./model/shortText.js`) and `writeStructured` for one
 * object in a fixed shape, optionally from pictures (`./model/structured.js`). Both say why there
 * is no answer rather than failing.
 */
const PLAIN_CODE_RUNTIMES = Object.freeze({
  // Chrome and a handful of pages, sampled into a design system. See `./designSystem/runtime.js`.
  [RUNTIME_REQUIREMENTS.designSystem]: ({ database, logger, writeStructured }) =>
    createDesignSystemRuntime({ database, logger, writeStructured }),
});

/**
 * Builds the runtimes this worker can execute in.
 *
 * `model` reasons through whichever provider the route table names, with Orbik's own key. Beside
 * it sit the plain-code runtimes, each chosen by the requirement a definition names.
 */
function buildRuntimes({ config, database, logger, callLog, retrieval, retrievalReason }) {
  const modelRouter = createModelRouter({ providers: createProviders({ config, callLog }) });
  const collaborators = {
    config,
    database,
    logger,
    retrieval,
    retrievalReason,
    writeText: createShortTextWriter({ modelRouter, logger }),
    writeStructured: createStructuredWriter({ modelRouter, logger }),
  };

  return {
    model: createModelRuntime({ modelRouter, logger }),
    plain: Object.fromEntries(
      Object.entries(PLAIN_CODE_RUNTIMES).map(([requirement, build]) => [requirement, build(collaborators)]),
    ),
  };
}
