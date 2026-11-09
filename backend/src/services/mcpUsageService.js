import { MCP_CALL_RETENTION_DAYS } from "../mcp/mcpCallLog.js";
import { createWorkspaceAccessCheck } from "./workspaceAccess.js";

/** The windows the report may be read over, in days. The longest is everything that is kept. */
export const MCP_USAGE_WINDOWS = Object.freeze(["7", "30", String(MCP_CALL_RETENTION_DAYS)]);

/** How many of the questions answered least well the report lists. */
const QUESTION_LIMIT = 50;

/**
 * "What your AI asked": a workspace's MCP call log, read back for the settings page.
 *
 * Admins and the owner only. The questions are what people's own AIs went looking for — every
 * member's, and the queries can carry the words of a conversation — so reading them is held to the
 * people who manage the workspace, as its invites and its crawled data are. The report names the
 * client each question came through, never the person.
 *
 * @param {object} options
 * @param {object} options.workspaceRepository workspace access by owner or membership
 * @param {object} options.mcpCallLog the log the MCP endpoint writes (`mcp/mcpCallLog.js`)
 */
export function createMcpUsageService({ workspaceRepository, mcpCallLog }) {
  const requireWorkspaceAccess = createWorkspaceAccessCheck(workspaceRepository);

  return {
    /**
     * The workspace's AI usage over the last `days` days: how many calls, through which tools and
     * clients, how many questions came back empty, and the questions answered least well.
     */
    async report({ userId, workspaceId, days }) {
      await requireWorkspaceAccess(userId, workspaceId, { role: "admin" });
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const summary = await mcpCallLog.summarise(workspaceId, { since, questionLimit: QUESTION_LIMIT });
      return { days, since: since.toISOString(), keptDays: MCP_CALL_RETENTION_DAYS, ...summary };
    },
  };
}
