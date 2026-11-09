/**
 * Choosing which of a credential's workspaces one call reads.
 *
 * The property this module exists to keep: **the workspace a call reads is always a member of the
 * set that was read from the database for this credential on this request.** The `workspace`
 * argument a roaming client sends is only ever compared with the members of that set — it is never
 * looked up on its own — so it can select within the set and cannot reach outside it. A pinned
 * credential is never asked: its one workspace is the answer, and its tools do not advertise the
 * argument at all.
 */

/** A call that needs a workspace and was not told which, or was told ambiguously. */
export const WORKSPACE_REQUIRED = "WORKSPACE_REQUIRED";

/**
 * A call that named a workspace outside the set. One code whether the workspace is not in the
 * set, belongs to somebody else or does not exist, so the endpoint confirms nothing about ids.
 */
export const WORKSPACE_NOT_ALLOWED = "WORKSPACE_NOT_ALLOWED";

/** What `workspace` may be, said where a model reads it: in the argument's own description. */
export const WORKSPACE_ARGUMENT_DESCRIPTION =
  "Which workspace to read: its id, its website host (e.g. \"example.com\") or its exact name. " +
  "The choices are in this server's instructions and in workspace_list.";

/** The same, for a write tool: whose Library the write goes into. */
export const WORKSPACE_WRITE_ARGUMENT_DESCRIPTION =
  "Which workspace's Library to write to: its id, its website host (e.g. \"example.com\") or its " +
  "exact name. The choices are in this server's instructions and in workspace_list.";

/**
 * A refusal to pick a workspace, carrying the choices so the model can correct its next call
 * without a round trip through `workspace_list`.
 */
export class WorkspaceRefusal extends Error {
  /**
   * @param {object} options
   * @param {string} options.code `WORKSPACE_REQUIRED` or `WORKSPACE_NOT_ALLOWED`
   * @param {string} options.message what to tell the model
   * @param {Array<{id: string, name: string, host: string | null}>} options.workspaces the choices
   */
  constructor({ code, message, workspaces }) {
    super(message);
    this.name = "WorkspaceRefusal";
    this.code = code;
    this.workspaces = workspaces;
  }
}

/** The choices a refusal lists: enough to name one, nothing more. */
export function choicesOf(session) {
  return session.workspaces.map(({ id, name, host }) => ({ id, name, host }));
}

/**
 * Picks the workspace one call reads.
 *
 * A pinned session answers its one workspace whatever it is given. A roaming one resolves `value`
 * by id, by website host or by exact name, case-insensitively, against the session's members only.
 *
 * @param {object} session the request's session, from `mcpService.openSession`
 * @param {unknown} value the `workspace` argument the client sent, if any
 * @returns {{id: string, name: string, websiteUrl: string | null, host: string | null}}
 * @throws {WorkspaceRefusal}
 */
export function chooseWorkspace(session, value) {
  if (!session.roaming) return session.workspaces[0];

  const wanted = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!wanted) {
    throw new WorkspaceRefusal({
      code: WORKSPACE_REQUIRED,
      message:
        "This connection reads more than one workspace. Say which one with `workspace` — an id, a " +
        "website host or a name from the list below — and call again.",
      workspaces: choicesOf(session),
    });
  }

  // An id names at most one workspace, so it is tried first and settles the question.
  if (/^[0-9a-f]{24}$/.test(wanted)) {
    const member = session.workspaces.find((workspace) => workspace.id === wanted);
    if (member) return member;
    throw notAllowed(session);
  }

  const host = hostKey(wanted);
  const matches = session.workspaces.filter(
    (workspace) =>
      workspace.name.trim().toLowerCase() === wanted || (workspace.host && hostKey(workspace.host) === host),
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new WorkspaceRefusal({
      code: WORKSPACE_REQUIRED,
      message:
        `"${String(value).trim().slice(0, 100)}" names more than one workspace this connection reads. Use the id of ` +
        "the one you mean, from the list below.",
      workspaces: choicesOf(session),
    });
  }
  throw notAllowed(session);
}

/**
 * Picks a workspace named by its id alone, as a resource address or a `fetch` id carries it.
 *
 * @throws {WorkspaceRefusal} `WORKSPACE_NOT_ALLOWED` for anything that is not a member's id
 */
export function workspaceById(session, id) {
  const wanted = String(id ?? "").toLowerCase();
  const member = session.workspaces.find((workspace) => workspace.id === wanted);
  if (!member) throw notAllowed(session);
  return member;
}

/** The one refusal for a workspace outside the set, whatever the reason it is outside. */
function notAllowed(session) {
  return new WorkspaceRefusal({
    code: WORKSPACE_NOT_ALLOWED,
    message: "That is not a workspace this connection may read. Use one from the list below.",
    workspaces: choicesOf(session),
  });
}

/**
 * Reduces a host, or a URL somebody pasted instead of one, to what is compared.
 *
 * A leading `www.` is ignored on both sides: "example.com" and "www.example.com" are one site to
 * the person typing it, and two workspaces that differ only by it would be a strange thing to own.
 */
function hostKey(value) {
  let host = value;
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      // Not a URL after all; compared as typed.
    }
  }
  return host.replace(/\/+$/, "").replace(/^www\./, "");
}
