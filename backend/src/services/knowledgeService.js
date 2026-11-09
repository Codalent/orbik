import { LLMS_TXT_AGENT_SLUG } from "@orbik/core";

import { AppError } from "../errors/appError.js";
import { createWorkspaceAccessCheck } from "./workspaceAccess.js";

/**
 * Reading the llms.txt file, and what either knowledge agent decided about the site's pages.
 *
 * The business knowledge base used to be served from here as a flat list of pages. It is now the
 * Library, a tree that people edit as well as agents, and it has its own service; what is left
 * here is the one deliverable that is genuinely a single file, and the source ledger both agents
 * write.
 *
 * The source verdicts matter because the most common question about an agent that chooses what to
 * read is why it left something out, and the answer is recorded per source in the agent's own
 * words — now including whole routes, which is the form that keeps answering the question as the
 * site grows.
 *
 * @param {object} dependencies collaborators
 * @param {object} dependencies.workspaceRepository workspace access by owner or membership
 * @param {object} dependencies.knowledgeRepository knowledge documents and source verdicts
 * @param {object} dependencies.crawlRepository crawl data, for the site a workspace reads from
 * @param {object} dependencies.runRepository agent runs, for when the file was last written
 */
export function createKnowledgeService({ workspaceRepository, knowledgeRepository, crawlRepository, runRepository }) {
  const requireWorkspaceAccess = createWorkspaceAccessCheck(workspaceRepository);

  /** The crawl site a workspace's agents read from, or null when it has never been configured. */
  function findSite(workspaceId) {
    return crawlRepository.findSiteByWorkspace(workspaceId);
  }

  /**
   * How the last run of an agent went, in the three facts the page needs.
   *
   * A failed last run matters here more than elsewhere: the documents on screen are still the
   * previous run's, and showing them without saying the newest attempt failed would present stale
   * content as current.
   */
  function toRunSummary(run) {
    if (!run) return null;
    return {
      id: run._id.toHexString(),
      status: run.status,
      startedAt: run.startedAt ? new Date(run.startedAt).toISOString() : null,
      finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
      error: run.error ? { code: run.error.code, message: run.error.message } : null,
    };
  }

  return {
    /**
     * Asks for the knowledge base to be written from a page that was left out of it.
     *
     * The one write on this service, and it is a request rather than a verdict: it records that a
     * person wants this page used, and the source layer's next pass marks it chosen. That is what
     * keeps the ledger's read-only rule intact — nothing here claims anything was reviewed — while
     * making the reason shown beside every page that was left out something a person can disagree
     * with.
     *
     * Deliberately does not enqueue. The API never does: it records state, and the scheduler in
     * the agents process notices.
     */
    async includeSource({ userId, workspaceId, agentSlug, key }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "member" });
      const included = await knowledgeRepository.requestSourcePage({
        workspaceId: workspace._id,
        agentSlug,
        sourceKey: key,
      });
      if (!included) {
        throw new AppError({
          status: 404,
          code: "SOURCE_NOT_FOUND",
          message: "That page is not one this agent has a verdict on.",
        });
      }
      return {
        source: included,
        // Said plainly because the action is asynchronous and the button that triggered it is not:
        // a person who sees "included" and then nothing about the page concludes it failed.
        status: "queued",
        message: "The knowledge base will be written from this page on the agent's next run.",
      };
    },

    /**
     * What one agent decided about the site's pages, and why.
     *
     * Filtered by verdict rather than returned whole, because the two halves answer different
     * questions: "what is this built from" and "what did it leave out".
     */
    async listSources({ userId, workspaceId, agentSlug, relevant, limit, skip }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "read-only" });
      const { items, total } = await knowledgeRepository.listSources({
        workspaceId: workspace._id,
        agentSlug,
        relevant,
        limit,
        skip,
      });
      return {
        total,
        skip,
        limit,
        items: items.map((source) => ({
          kind: source.sourceKind ?? "page",
          key: source.sourceKey ?? source.urlHash ?? null,
          url: source.url,
          title: source.title ?? null,
          relevant: source.relevant === true,
          reason: source.reason ?? null,
          // False for a page no request can bring in, so the interface does not offer to.
          includable: source.includable !== false,
          reviewedAt: source.reviewedAt ? new Date(source.reviewedAt).toISOString() : null,
        })),
      };
    },

    /** The llms.txt file, with the sections parsed out of it when one has been written. */
    async getLlmsDocument({ userId, workspaceId }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "read-only" });
      const [document, latestRun, site] = await Promise.all([
        knowledgeRepository.findLlmsDocument(workspace._id),
        runRepository.findLatest({ workspaceId: workspace._id, agentSlug: LLMS_TXT_AGENT_SLUG }),
        findSite(workspace._id),
      ]);
      const [markdownPages, sources] = await Promise.all([
        site ? crawlRepository.countMarkdown({ siteId: site._id }) : 0,
        knowledgeRepository.countSources({ workspaceId: workspace._id, agentSlug: LLMS_TXT_AGENT_SLUG }),
      ]);
      return {
        document: document
          ? {
            content: document.content,
            title: document.title ?? null,
            summary: document.summary ?? null,
            notes: document.notes ?? null,
            sections: (document.sections ?? []).map((section) => ({
              name: section.name,
              links: (section.links ?? []).map((link) => ({
                title: link.title,
                url: link.url,
                description: link.description ?? null,
              })),
            })),
            links: document.links ?? 0,
            bytes: document.bytes ?? 0,
            revision: document.revision ?? 1,
            updatedAt: document.updatedAt ? new Date(document.updatedAt).toISOString() : null,
          }
          : null,
        sources,
        latestRun: toRunSummary(latestRun),
        readiness: { crawled: Boolean(site), markdownPages },
      };
    },
  };
}
