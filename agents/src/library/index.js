import { log } from "@orbik/core";

import { LIBRARY_AGENT, LIBRARY_JOBS } from "../jobs.js";
import { defineAgent } from "../runtime/registry.js";
import { createEmbedHandler } from "./embed.js";
import { createMirrorHandler } from "./mirror.js";
import { createStructureHandler } from "./structure.js";

/**
 * The Library agent: everything that turns a crawled site into a workspace's knowledge.
 *
 * It is one agent with three stages, and nobody starts any of them by hand. The crawler hands a
 * site over when it finishes, and each stage follows from the one before:
 *
 * 1. **Mirror** (`sources.mirror`) — every page that is new or changed is copied into the source
 *    layer under `/sources/website`, as it was crawled, and the pages the knowledge base is
 *    written from are chosen by rule. No model is called.
 * 2. **Embed** (`index.embed`) — the retrieval index over the pages and the Library's files.
 * 3. **Write** — a run of the `business-knowledge-base` definition, which reads the chosen pages
 *    and rewrites the subject tree. `libraryScheduler.js` starts it once the mirror has settled
 *    and something among the chosen pages moved.
 *
 * Between the first stage and the first write run sits one question rather than a stage: which
 * top-level folders the Library should have. A person chooses them, from two or three variants a
 * model proposes (`structure.suggest`, `./structure.js`); the scheduler waits for the choice
 * before it starts the write run.
 *
 * The first two are handlers here. The third is a conversation with a model, so it is an agent
 * *definition* executed by the `ai` agent — it needs instructions, a tool allow-list and a run a
 * person can watch, and the first two need none of those. They are stages of one agent because
 * they are one piece of work with one switch, not because they are one kind of code.
 *
 * Stages are separate jobs rather than one job with three steps, so each can fail, retry and be
 * unavailable on its own: a workspace with no model still gets its pages mirrored and indexed, and
 * one with no Qdrant still gets its mirror and its Library.
 *
 * @param {object} options collaborators
 * @param {object|null} options.retrieval the retrieval index, or null when none is configured
 * @param {{code: string, message: string}|null} [options.retrievalReason] why there is none
 * @param {((request: object) => Promise<object>)|null} [options.writeStructured] the structured
 *   writer the structure suggestion asks with; null on a worker with no model
 * @param {(level: string, message: string, context?: object) => void} [options.logger]
 */
export function createLibraryAgent({ retrieval, retrievalReason = null, writeStructured = null, logger = log }) {
  return defineAgent({
    name: LIBRARY_AGENT,
    version: 1,
    handlers: {
      [LIBRARY_JOBS.mirror]: createMirrorHandler({ logger }),
      [LIBRARY_JOBS.embed]: createEmbedHandler({ retrieval, reason: retrievalReason, logger }),
      [LIBRARY_JOBS.suggest]: createStructureHandler({ writeStructured, logger }),
    },
  });
}
