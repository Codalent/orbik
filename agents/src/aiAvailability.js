import { COLLECTIONS } from "@orbik/core";

/** The `system_state` document the worker keeps its AI settings' outcome in. */
export const AI_AVAILABILITY_ID = "ai";

/**
 * Records, at the worker's start, whether the reasoning provider it resolved has its key and
 * whether the embedding key is set: never a key, only the two answers and the provider's name.
 *
 * The API reads it for `GET /v1/edition` (`ai`), so the web app can say before a person presses
 * Run that no AI is available. The API cannot work that out itself: the reasoning keys are read
 * from the worker's environment (`agents/.env`), which the API does not see in a plain install.
 * The last worker to start wins; every worker of an install reads the same settings.
 *
 * Writing it can never stop the worker: a failure is logged, and the API then reports nothing it
 * does not know.
 *
 * @param {object} options
 * @param {import("mongodb").Db} options.database
 * @param {{aiProvider: string, aiProviderConfigured: boolean, retrievalEnabled: boolean}} options.config
 * @param {Function} options.logger
 */
export async function recordAiAvailability({ database, config, logger }) {
  try {
    await database.collection(COLLECTIONS.systemState).updateOne(
      { _id: AI_AVAILABILITY_ID },
      {
        $set: {
          provider: config.aiProvider,
          reasoning: Boolean(config.aiProviderConfigured),
          embeddings: Boolean(config.retrievalEnabled),
          recordedAt: new Date(),
        },
      },
      { upsert: true },
    );
  } catch (error) {
    logger("warn", "ai.availability_not_recorded", { message: error.message });
  }
}
