import { MongoClient, ServerApiVersion } from "mongodb";

let activeClient = null;
let activeDatabase = null;

/** Connects once using MongoDB Stable API v1. */
export async function connectMongo(config) {
  if (activeDatabase) return activeDatabase;
  const client = new MongoClient(config.mongodbUri, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    },
  });
  await client.connect();
  activeClient = client;
  activeDatabase = client.db(config.databaseName);
  return activeDatabase;
}

/** Returns true only when the configured database responds to ping. */
export async function isMongoReady(database = activeDatabase) {
  if (!database) return false;
  try {
    await database.command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

/** Closes the active MongoDB client and clears module state. */
export async function closeMongo() {
  if (activeClient) await activeClient.close();
  activeClient = null;
  activeDatabase = null;
}
