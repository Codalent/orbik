import { createAiCallLog } from "@orbik/core";
import { activeExtensions, createAiCallHooks } from "@orbik/extensions";
import { createRetrieval } from "@orbik/retrieval";

import { createCrawlerAgent } from "./crawler/index.js";
import { createAiAgent } from "./ai/index.js";
import { createModelRouter } from "./ai/model/modelRouter.js";
import { createProviders } from "./ai/model/providers/index.js";
import { createStructuredWriter } from "./ai/model/structured.js";
import { createLibraryAgent } from "./library/index.js";
import { defineAgent } from "./runtime/registry.js";

/**
 * Every agent this deployment can execute.
 *
 * Registration is a single explicit list so that "which agents run here" is answerable by
 * reading one file. There are three, and they are different in kind:
 *
 * - `crawler` is deterministic code. It goes to a site, respects its robots.txt, and records what
 *   it found. No model is involved, because none is needed to parse a sitemap.
 * - `ai` executes agent *definitions* — versioned rows holding instructions and a tool allow-list.
 *   Adding a new agent of that kind adds a definition, not an entry here.
 * - `library` is the two stages of the Library agent that are plain code: a copy of every crawled
 *   page in the source layer, and the retrieval index over the pages and the Library's files.
 *   Which page moved is a hash comparison in both, so neither is a definition, and neither calls a
 *   reasoning model. The Library agent's third stage, writing the subject tree, *is* a definition
 *   and runs under `ai` — see `./library/index.js`.
 *
 * The retrieval index is built once here and shared by the Library agent and the AI agent. The
 * embedding stage fills it and the AI agent's tools query it, and they must be the same index: two would mean a search
 * answered from a different collection than the one the embeddings were written to.
 *
 * @param {object} options collaborators the AI agent needs to reach providers
 * @param {object} options.config validated agent environment
 * @param {import("mongodb").Db} options.database connected database
 * @param {(level: string, message: string, context?: object) => void} options.logger
 * @param {object} [options.extensions] the extensions this process loaded: their agents are added
 *   after the core ones, and the call log tells them about every model call
 */
export function createAgents({ config, database, logger, extensions = activeExtensions() }) {
  // One log for every model call this process makes, whichever agent made it.
  const callLog = createAiCallLog({ database, logger, hooks: createAiCallHooks({ database, host: extensions }) });
  const { index: retrieval, reason } = createRetrieval({ database, config, logger, callLog });
  if (!retrieval) logger("warn", "index.disabled", { code: reason.code, message: reason.message });

  return [
    createCrawlerAgent({}),
    createAiAgent({ config, database, logger, callLog, retrieval, retrievalReason: reason }),
    createLibraryAgent({
      retrieval,
      retrievalReason: reason,
      // The one model question the Library's plain-code stages ask: which folders to propose.
      // Through the same router and call log as every other call, so it is recorded in `ai_calls`.
      writeStructured: createStructuredWriter({
        modelRouter: createModelRouter({ providers: createProviders({ config, callLog }) }),
        logger,
      }),
      logger,
    }),
    // An extension's agents, validated exactly as a core one is. A name that is already taken is
    // refused by the registry, so an extension cannot replace the crawler or the Library.
    ...extensions.agents.map((agent) => defineAgent(agent)),
  ];
}
