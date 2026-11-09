import { AGENT_COLLECTIONS } from "@orbik/core";

/** Finds the crawl site a workspace's pages come from, or null when it has never been crawled. */
export async function findSite(database, workspaceId) {
  const site = await database
    .collection(AGENT_COLLECTIONS.sites)
    .findOne({ workspaceId }, { projection: { _id: 1 } });
  return site?._id ?? null;
}
