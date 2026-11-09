import { LIBRARY_CHUNK_KIND } from "@orbik/library";

import { chooseWorkspace, workspaceById } from "./workspaceChoice.js";

/** How many results the two-tool surface returns. ChatGPT's own reader opens only a handful. */
const SEARCH_LIMIT = 10;

/**
 * The kinds `search` looks in, which is exactly the set `fetch` can open again.
 *
 * `document` is left out on purpose. A citation the client cannot follow is worse than a result it
 * never saw, and an uploaded document has no page URL and no Library path to re-read it by.
 */
const FETCHABLE_KINDS = Object.freeze(["page", LIBRARY_CHUNK_KIND]);

/**
 * Builds the `search` and `fetch` pair, in the exact shape ChatGPT requires.
 *
 * They exist for two reasons. ChatGPT's deep-research and company-knowledge paths refuse a server
 * that does not offer these two names with this contract — so without them Orbik is invisible to
 * one of the two clients this server was asked for. And they are the smallest possible surface for
 * any agent framework that only knows how to "find, then open", which is most of them.
 *
 * They add no reader of their own: `search` is `content.search` and `fetch` is one `library.read`
 * or one `content.readPages`, through the same registry every other tool goes through, scoped to
 * a workspace of the credential's set.
 *
 * A pinned credential's ids are `library:<path>` and `page:<url>`, as they always were. A roaming
 * credential's carry the workspace — `library:<workspaceId>:<path>`, `page:<workspaceId>:<url>` —
 * because ChatGPT's `fetch` takes the id and nothing else, so the id is the only place the choice
 * can travel. `fetch` checks that workspace against the set before it opens anything.
 *
 * @param {object} options
 * @param {object} options.session the request's session: its workspaces and whether it roams
 * @param {(workspace: object) => Promise<object>} options.registryFor a registry scoped to one member
 * @param {(workspaceId: string, path: string) => string} options.libraryUrl a Library path as a URL a
 *   person can open
 */
export function createSearchAndFetch({ session, registryFor, libraryUrl }) {
  return {
    /**
     * Finds passages and returns one identifier per source, not per passage.
     *
     * Deduplicated because `content.search` answers with passages and several of them routinely
     * come from one page: a result list naming the same page five times reads, to the client, as
     * five sources agreeing.
     *
     * A roaming credential that names no workspace searches every one it covers, once each, and the
     * passages are merged by score. That is the one place this surface reads several workspaces in
     * one call, and it is here only because ChatGPT's contract has no argument to carry a choice.
     *
     * `searched` is told what each workspace's search returned, for the call log, so the answer
     * the client gets keeps exactly ChatGPT's shape.
     */
    async search({ query, workspace }, signal, searched = null) {
      const targets = !session.roaming
        ? session.workspaces
        : typeof workspace === "string" && workspace.trim()
          ? [chooseWorkspace(session, workspace)]
          : session.workspaces;

      const found = await Promise.all(
        targets.map(async (target) => {
          const tools = await registryFor(target);
          const answer = await tools.invoke(
            "content.search",
            { query, kinds: [...FETCHABLE_KINDS], limit: SEARCH_LIMIT },
            signal,
          );
          searched?.({ workspace: target, answer, fanOut: targets.length > 1 });
          return answer.results.map((passage) => ({ passage, workspace: target }));
        }),
      );
      // Stable, so passages with equal scores keep their workspace's order.
      const passages = found.flat().sort((left, right) => (right.passage.score ?? 0) - (left.passage.score ?? 0));

      const results = [];
      const seen = new Set();
      for (const { passage, workspace: owner } of passages) {
        if (results.length >= SEARCH_LIMIT) break;
        const id = identifierFor(passage, session.roaming ? owner.id : null);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const title = titleFor(passage);
        results.push({
          id,
          // Two workspaces' Libraries both have an /overview; the name is what tells them apart.
          title: session.roaming ? `${title} (${owner.name})` : title,
          url: passage.sourceKind === "page" ? (passage.cite ?? passage.url ?? "") : libraryUrl(owner.id, passage.path),
        });
      }
      return { results };
    },

    /**
     * Opens one identifier `search` returned.
     *
     * The identifier says which reader to use rather than being guessed from its shape, so a
     * Library path that happens to look like a URL — or the other way round — cannot send the call
     * to the wrong one.
     */
    async fetch({ id }, signal) {
      const { kind, reference, workspace } = parseIdentifier(session, id);
      const tools = await registryFor(workspace);
      const owner = session.roaming ? { workspace: workspace.id } : {};

      if (kind === "library") {
        const node = await tools.invoke("library.read", { path: reference }, signal);
        return {
          id,
          title: node.title ?? node.name ?? reference,
          text: node.markdown ?? describeFolder(node),
          url: libraryUrl(workspace.id, node.path),
          metadata: {
            source: "library",
            ...owner,
            path: node.path,
            kind: node.kind,
            writtenByAPerson: String(Boolean(node.hasUserContent)),
            updatedAt: node.updatedAt ?? "",
          },
        };
      }

      const read = await tools.invoke("content.readPages", { urls: [reference] }, signal);
      const page = read.pages[0];
      if (!page) {
        const error = new Error(
          read.missing?.length
            ? "That page is not in this workspace's crawl."
            : "That page could not be read.",
        );
        error.code = "PAGE_MISSING";
        throw error;
      }
      return {
        id,
        title: page.title ?? page.url,
        text: page.markdown,
        url: page.url,
        metadata: {
          source: "page",
          ...owner,
          truncated: String(Boolean(page.truncated)),
          words: String(page.words ?? ""),
          changedAt: page.changedAt ?? "",
        },
      };
    },
  };
}

/**
 * Splits an id `search` returned into the reader, the reference and the workspace it names.
 *
 * A roaming id's workspace is checked against the set here, before anything is read: an id is a
 * string the client holds and could have edited.
 */
function parseIdentifier(session, id) {
  if (!session.roaming) {
    const parsed = /^(library|page):(.+)$/s.exec(String(id ?? ""));
    if (!parsed) throw invalidId('An id must be one search returned, shaped "library:<path>" or "page:<url>".');
    return { kind: parsed[1], reference: parsed[2], workspace: session.workspaces[0] };
  }
  const parsed = /^(library|page):([0-9a-fA-F]{24}):(.+)$/s.exec(String(id ?? ""));
  if (!parsed) {
    throw invalidId(
      'An id must be one search returned, shaped "library:<workspace id>:<path>" or "page:<workspace id>:<url>".',
    );
  }
  return { kind: parsed[1], reference: parsed[3], workspace: workspaceById(session, parsed[2]) };
}

/** The refusal for an id that is not one `search` could have returned. */
function invalidId(message) {
  const error = new Error(message);
  error.code = "INVALID_ID";
  return error;
}

/**
 * The identifier of the source a passage came from, or null when it has none to open.
 *
 * @param {object} passage one `content.search` result
 * @param {string | null} workspaceId the workspace to carry in the id, for a roaming credential
 */
function identifierFor(passage, workspaceId) {
  const prefix = workspaceId ? `${workspaceId}:` : "";
  if (passage.sourceKind === "page") return passage.url ? `page:${prefix}${passage.url}` : null;
  return passage.path ? `library:${prefix}${passage.path}` : null;
}

/** A title that says which document *and* which part of it, since a passage is part of one. */
function titleFor(passage) {
  const heading = (passage.headingPath ?? []).at(-1);
  const title = passage.title ?? passage.path ?? passage.url ?? "Untitled";
  return heading && heading !== title ? `${title} — ${heading}` : title;
}

/** What a folder reads as, since `fetch` promises text and a folder has none of its own. */
function describeFolder(node) {
  const children = (node.children ?? []).map((child) => `- ${child.path} — ${child.title ?? child.name}`);
  return [node.summary ?? "", "", ...children].join("\n").trim();
}
