/**
 * Reading the run's authorization scope.
 *
 * The scope is closed over when the registry is built, from the run document — never from the
 * model's arguments. These helpers are the only way a tool reaches it, so "which site" and "which
 * agent" are answered the same way everywhere, and a tool that needs something the run does not
 * have says so in words a model can act on rather than returning an empty list it will read as a
 * fact about the site.
 */

/**
 * The crawl site the run reads from.
 *
 * An agent whose definition declares crawl or content tools but which is run against a workspace
 * that was never crawled is a configuration mistake, and saying so is more useful than returning
 * an empty list the model will interpret as "this site has no pages".
 */
export function requireSite(scope) {
  if (!scope.siteId) {
    const error = new Error("This workspace has no crawl data yet. Run the crawler first.");
    error.code = "CRAWL_NOT_CONFIGURED";
    throw error;
  }
  return scope.siteId;
}

/**
 * The agent the run is executing, which is the namespace its source bookkeeping lives in.
 *
 * Per agent rather than per workspace because two agents reading the same site disagree about
 * what belongs in their output: a press release is a source for the knowledge base and a link in
 * llms.txt, while a changelog entry may be neither. Sharing one ledger would make each agent's
 * "what changed since I last looked" depend on when the other one ran.
 */
export function requireAgentSlug(scope) {
  if (!scope.agentSlug) {
    const error = new Error("This tool can only be called inside an agent run.");
    error.code = "AGENT_SCOPE_MISSING";
    throw error;
  }
  return scope.agentSlug;
}

/** The workspace the run belongs to; everything the agents write is owned by it. */
export function requireWorkspace(scope) {
  if (!scope.workspaceId) {
    const error = new Error("This tool can only be called inside a workspace run.");
    error.code = "WORKSPACE_SCOPE_MISSING";
    throw error;
  }
  return scope.workspaceId;
}
