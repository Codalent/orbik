import { PlanLimitError } from "./limits.js";
import { createOwnerLookup } from "./owners.js";

/** The `purpose` the AI call log records on an embedding request (`@orbik/retrieval`). */
const EMBEDDING_PURPOSE = "embedding";

/**
 * The two places the AI call log meets the extensions: before a call is made, and after it is
 * recorded. Handed to `createAiCallLog` as its `hooks` by each process that builds one.
 *
 * Before: a call made for a workspace whose plan does not include it is refused with
 * `PLAN_LIMIT_REACHED`, before anything is sent to a provider: any call when the plan's `aiCalls`
 * is false, and any call but an embedding when its `reasoningCalls` is. Without plan limits loaded
 * nothing is looked up at all.
 *
 * After: the completed `ai_calls` row is told to `ai.call.finished` listeners — which is how an
 * extension meters model usage from the same record a person reads in the AI call log.
 *
 * @param {object} options
 * @param {import("mongodb").Db} options.database
 * @param {ReturnType<import("./host.js").createExtensionHost>} options.host
 */
export function createAiCallHooks({ database, host }) {
  const ownerOf = createOwnerLookup(database);
  return {
    async beforeBegin(call) {
      if (!host.hasPlanLimits || !call.workspaceId) return;
      const limits = await host.limitsFor({ ownerId: await ownerOf(call.workspaceId), workspaceId: call.workspaceId });
      if (!limits.aiCalls) {
        throw new PlanLimitError({
          limit: "aiCalls",
          message: "This workspace's plan does not include AI, so no model was asked.",
        });
      }
      if (!limits.reasoningCalls && call.purpose !== EMBEDDING_PURPOSE) {
        throw new PlanLimitError({
          limit: "reasoningCalls",
          message: "This workspace's plan has no AI left for this, so no model was asked. Its pages are still indexed and searchable.",
        });
      }
    },
    async afterFinish(record) {
      await host.emit("ai.call.finished", { call: record });
    },
  };
}
