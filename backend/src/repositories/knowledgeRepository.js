import { toObjectId } from "@orbik/core";
import { LIBRARY_SOURCE_KINDS, SOURCE_FIXED_SKIPS } from "@orbik/library";
import { recordPersonVerdict } from "@orbik/tools";

/**
 * Reads the llms.txt file and the source verdicts behind both knowledge agents.
 *
 * Read-only but for one write, and the exception is worth stating because the rule it bends was
 * deliberate. The llms.txt file is a deliverable whose every link is checked against pages the
 * crawler actually fetched, and the source ledger is an agent's own record of what it has
 * accounted for — a second door into either would let a person produce a file with a link to
 * nothing, or tell an agent it had reviewed something it never read.
 *
 * {@link requestSourcePage} does neither. It does not assert that anything was reviewed: it
 * records that a person wants the knowledge base written from a page, which the source layer's
 * next pass acts on and which its own rules still get to refuse (a duplicate URL is still a
 * duplicate). The ledger entry it writes is stamped `user`, so nothing downstream mistakes it for
 * an agent's judgement. Without it the answer to "why is my best blog post not in here?" would be
 * a reason and no way to disagree with it.
 *
 * @param {object} collections agent-owned collection handles from `getAgentCollections`
 * @param {import("mongodb").Db} database the same database, for the shared ledger writer
 */
export function createKnowledgeRepository(collections, database) {
  const { knowledgeSources, llmsDocuments, sourceNotes } = collections;

  return {
    /** The workspace's llms.txt, or null when no run has written one. */
    findLlmsDocument(workspaceId) {
      return llmsDocuments.findOne({ workspaceId: toObjectId(workspaceId) });
    },

    /**
     * How many source pages one agent has judged each way.
     *
     * Read as a single aggregation rather than three counts, because the interface shows them
     * together as one sentence — "48 pages used, 96 set aside" — and three round trips to say one
     * sentence is three chances for them to disagree.
     */
    async countSources({ workspaceId, agentSlug }) {
      if (!workspaceId) return { used: 0, excluded: 0 };
      const rows = await knowledgeSources
        .aggregate([
          { $match: { workspaceId: toObjectId(workspaceId), agentSlug } },
          { $group: { _id: "$relevant", count: { $sum: 1 } } },
        ])
        .toArray();
      return {
        used: rows.find((row) => row._id === true)?.count ?? 0,
        excluded: rows.find((row) => row._id === false)?.count ?? 0,
      };
    },

    /**
     * One agent's verdicts on a workspace's sources.
     *
     * Keyed on the workspace rather than the site, because a verdict is no longer only ever about
     * a page of the crawled site: a route pattern stands for every page under it, and a source
     * from somewhere other than the website has no site at all.
     */
    async listSources({ workspaceId, agentSlug, relevant, limit, skip }) {
      if (!workspaceId) return { items: [], total: 0 };
      const filter = { workspaceId: toObjectId(workspaceId), agentSlug };
      if (relevant !== undefined) filter.relevant = relevant;
      const [items, total] = await Promise.all([
        knowledgeSources.find(filter).sort({ sourceKind: 1, url: 1, sourceKey: 1 }).skip(skip).limit(limit).toArray(),
        knowledgeSources.countDocuments(filter),
      ]);
      // Which of these a person could not pull in by asking: a duplicate URL, a page with no text.
      // Read from the source layer's own rows, so the answer is its rule and not a guess from the
      // wording of a reason.
      const fixed = items.length
        ? await sourceNotes
          .find({
            workspaceId: filter.workspaceId,
            sourceKey: { $in: items.map((item) => item.sourceKey).filter(Boolean) },
            skipped: { $in: [...SOURCE_FIXED_SKIPS] },
          })
          .project({ sourceKey: 1 })
          .toArray()
        : [];
      const unaskable = new Set(fixed.map((row) => row.sourceKey));
      return { items: items.map((item) => ({ ...item, includable: !unaskable.has(item.sourceKey) })), total };
    },

    /**
     * Records that a person wants the knowledge base written from a page, and returns what is
     * known about it.
     *
     * Two writes, both of state rather than of work: the page's state row is marked `include`,
     * which is the flag the selection honours ahead of every rule of its own, and the ledger row
     * is flipped so the interface stops saying the page was left out. Nothing is enqueued — the
     * API never enqueues, and the Library scheduler notices an outstanding include on its next
     * tick: one pass marks the page chosen, and that is what starts the next write run.
     *
     * Returns null when the workspace has no such source, so the caller can answer 404 rather than
     * silently accepting a key that means nothing.
     */
    async requestSourcePage({ workspaceId, agentSlug, sourceKey, now = new Date() }) {
      const owner = toObjectId(workspaceId);
      const row = await knowledgeSources.findOne({ workspaceId: owner, agentSlug, sourceKind: "page", sourceKey });
      if (!row) return null;

      await sourceNotes.updateOne(
        { workspaceId: owner, sourceKey },
        {
          // Not chosen yet, whatever the row said: that is what tells the scheduler a request is
          // outstanding, and the pass that honours it sets it back.
          $set: { include: true, includedAt: now, chosen: false },
          // The skip label and any recorded failure are both stale the moment somebody asks for
          // the page: it is pending now, whatever it was.
          $unset: { skipped: "", reason: "", skippedAt: "", error: "" },
          $setOnInsert: {
            workspaceId: owner,
            sourceKey,
            siteId: row.siteId ?? null,
            sourceKind: "page",
            url: row.url ?? null,
            createdAt: now,
          },
        },
        { upsert: true },
      );

      await recordPersonVerdict({
        database,
        workspaceId: owner,
        agentSlug,
        source: { kind: LIBRARY_SOURCE_KINDS.page, key: sourceKey },
        relevant: true,
        reason: "You asked for this page to be included.",
        now,
      });

      return { key: sourceKey, url: row.url ?? null, title: row.title ?? null };
    },
  };
}
