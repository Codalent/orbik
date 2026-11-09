import { PlanLimitError } from "./limits.js";
import { createOwnerLookup } from "./owners.js";

/**
 * The two places the AI call log meets the extensions: before a call is made, and after it is
 * recorded. Handed to `createAiCallLog` as its `hooks` by each process that builds one.
 *
 * Before: a call on behalf of a workspace whose owner's plan does not include AI calls is refused
 * with `PLAN_LIMIT_REACHED`, before anything is sent to a provider. Without plan limits loaded
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
      const limits = await host.limitsFor(await ownerOf(call.workspaceId));
      if (!limits.aiCalls) {
        throw new PlanLimitError({
          limit: "aiCalls",
          message: "This workspace's plan does not include AI, so no model was asked.",
        });
      }
    },
    async afterFinish(record) {
      await host.emit("ai.call.finished", { call: record });
    },
  };
}
