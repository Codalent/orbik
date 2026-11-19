import { AGENT_COLLECTIONS, websiteFilter } from "@orbik/core";

/** Finds the workspace's website — the crawl its own pages come from — or null when it has none. */
export async function findSite(database, workspaceId) {
  const site = await database
    .collection(AGENT_COLLECTIONS.sites)
    .findOne(websiteFilter(workspaceId), { projection: { _id: 1 } });
  return site?._id ?? null;
}

/**
 * Every source of a workspace, the website first.
 *
 * @returns {Promise<Array<{_id: import("mongodb").ObjectId, primary?: boolean, knowledgeUse?: string}>>}
 */
export async function listSites(database, workspaceId) {
  const rows = await database
    .collection(AGENT_COLLECTIONS.sites)
    .find({ workspaceId }, { projection: { _id: 1, primary: 1, knowledgeUse: 1 } })
    .toArray();
  return rows.sort((left, right) => Number(right.primary !== false) - Number(left.primary !== false)
    || left._id.toHexString().localeCompare(right._id.toHexString()));
}
