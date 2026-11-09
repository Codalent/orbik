import { randomBytes } from "node:crypto";

import { COLLECTIONS } from "@orbik/core";

/**
 * Fills in the secrets an install was told to generate for itself (`ORBIK_GENERATE_SECRETS=true`).
 *
 * The session secret and the asset-link secret are both used by this process alone, to sign and to
 * check what it signed, so one kept in the database is as good as one in the environment: whoever
 * can read the database can already read the sessions it protects. Each is generated once, the
 * first time any API process starts, and every process after that reads the same one. A value set
 * in the environment always wins.
 *
 * @param {Readonly<object>} config the parsed environment
 * @param {import("mongodb").Db} database
 * @returns {Promise<Readonly<object>>} the configuration with both secrets present
 */
export async function resolveSecrets(config, database) {
  if (!config.generateSecrets || (config.sessionSecret && config.assetUrlSecret)) return config;
  const generated = await database.collection(COLLECTIONS.systemState).findOneAndUpdate(
    { _id: "secrets" },
    {
      $setOnInsert: {
        sessionSecret: randomBytes(48).toString("base64url"),
        assetUrlSecret: randomBytes(48).toString("base64url"),
        createdAt: new Date(),
      },
    },
    { upsert: true, returnDocument: "after" },
  );
  return Object.freeze({
    ...config,
    sessionSecret: config.sessionSecret ?? generated.sessionSecret,
    assetUrlSecret: config.assetUrlSecret || generated.assetUrlSecret,
  });
}
