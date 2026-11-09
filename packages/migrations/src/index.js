import { hostname } from "node:os";

import { COLLECTIONS, log as defaultLog } from "@orbik/core";

import { MIGRATIONS } from "./migrations.js";

export { MIGRATIONS };

const LOCK_ID = "migrations";
const LEASE_MS = 60_000;
const POLL_MS = 2_000;
const WAIT_LIMIT_MS = 15 * 60_000;

/**
 * Brings a database up to the migrations this release knows, before the process that calls it
 * serves or claims anything.
 *
 * The API, the worker and the scheduler all call it at start, and any of them may be first after
 * an upgrade. One takes the lock in `system_state` and runs what is pending, in order, recording
 * each in `migrations` as it finishes; the others wait for the lock and find nothing left to do.
 * The lock is a lease the holder renews while it works, so a process killed mid-migration leaves
 * it to expire and the next start takes over.
 *
 * A migration that throws stops the process that ran it, with the migration's id, and is not
 * recorded: the next start tries it again. A database that has migrations this release does not
 * know — it was run by a newer release — is reported and left alone; downgrading is not supported.
 *
 * @param {object} options
 * @param {import("mongodb").Db} options.database
 * @param {Array<{id: string, description: string, up: Function}>} [options.migrations]
 * @param {Function} [options.logger]
 * @param {string} [options.holder] who holds the lock while this runs, for its log lines
 * @returns {Promise<{applied: string[], pending: number}>}
 */
export async function runMigrations({
  database,
  migrations = MIGRATIONS,
  logger = defaultLog,
  holder = `${hostname()}:${process.pid}`,
}) {
  assertOrdered(migrations);
  const records = database.collection(COLLECTIONS.migrations);
  const state = database.collection(COLLECTIONS.systemState);

  const pendingNow = async () => {
    const done = new Set((await records.find({}, { projection: { _id: 1 } }).toArray()).map((row) => row._id));
    const unknown = [...done].filter((id) => !migrations.some((migration) => migration.id === id));
    if (unknown.length) logger("warn", "migrations.unknown_applied", { unknown });
    return migrations.filter((migration) => !done.has(migration.id));
  };

  if (!(await pendingNow()).length) return { applied: [], pending: 0 };

  const deadline = Date.now() + WAIT_LIMIT_MS;
  while (!(await takeLock(state, holder))) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for another process to finish migrating the database.");
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  const renew = setInterval(() => {
    takeLock(state, holder).catch((error) => logger("warn", "migrations.lock_renew_failed", { message: error.message }));
  }, LEASE_MS / 3);
  const applied = [];
  try {
    // Read again under the lock: whoever held it before may have run them all.
    for (const migration of await pendingNow()) {
      const startedAt = new Date();
      logger("info", "migrations.started", { id: migration.id, description: migration.description });
      try {
        await migration.up({ database, logger });
      } catch (error) {
        throw new Error(`Migration ${migration.id} failed: ${error.message}`, { cause: error });
      }
      const durationMs = Date.now() - startedAt.getTime();
      await records.insertOne({ _id: migration.id, description: migration.description, appliedAt: new Date(), durationMs, by: holder });
      logger("info", "migrations.applied", { id: migration.id, durationMs });
      applied.push(migration.id);
    }
  } finally {
    clearInterval(renew);
    await state.deleteOne({ _id: LOCK_ID, holder });
  }
  return { applied, pending: 0 };
}

/** Takes or renews the lease; false while someone else holds an unexpired one. */
async function takeLock(state, holder) {
  const now = new Date();
  try {
    await state.updateOne(
      { _id: LOCK_ID, $or: [{ expiresAt: { $lte: now } }, { holder }] },
      { $set: { holder, expiresAt: new Date(now.getTime() + LEASE_MS) } },
      { upsert: true },
    );
    return true;
  } catch (error) {
    // The lock exists, held by someone else: the filter did not match and the upsert collided.
    if (error.code === 11000) return false;
    throw error;
  }
}

/** Ids must be unique and in order, so every install runs them in the same sequence. */
function assertOrdered(migrations) {
  for (let index = 0; index < migrations.length; index += 1) {
    const { id, up } = migrations[index];
    if (typeof id !== "string" || !/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/.test(id)) throw new Error(`Migration id ${id} must be YYYY-MM-DD-what-it-does.`);
    if (typeof up !== "function") throw new Error(`Migration ${id} has no up().`);
    if (index > 0 && migrations[index - 1].id >= id) throw new Error(`Migration ${id} is out of order or repeated.`);
  }
}
