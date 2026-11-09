import { AGENT_COLLECTIONS, escapeRegExp, toObjectId } from "@orbik/core";

import { LIBRARY_ERROR_CODES, LIBRARY_SOURCE_KINDS, LibraryError } from "./library.js";

/**
 * Where the Library's statements come from, and how a new kind of source is added later.
 *
 * Every citation is a reference, never a bare URL: `{kind, key, url|path, title, hash}`. The kind
 * is what makes the model extensible — a Notion page, a vault note or a meeting transcript is a
 * new provider module and a new kind, and nothing in the tools, the ledger or the API changes to
 * accept it. A bare URL would have made the crawl the only thing a Library could ever be built
 * from, which is precisely the limitation this replaces.
 *
 * The hash is what makes a second run cheap and honest. A provider that could only say "this
 * exists" would force every run to re-read everything; one that says "this is what it currently
 * hashes to" lets the ledger answer "what has genuinely changed since I last looked" by
 * comparison rather than by a timestamp.
 *
 * Two kinds are implemented here. `page` is the crawl, which is the only provider that exists
 * today. `document` is the shape everything else will arrive in — prose, stored per workspace in
 * `source_documents` — and it is built now so that a connector is one module rather than a change
 * to everything that cites a source.
 */

/**
 * @typedef {object} SourceReference
 * @property {string} kind one of {@link LIBRARY_SOURCE_KINDS}
 * @property {string} key the provider's stable identity for this source
 * @property {string|null} url where a person can open it, when it has a web address
 * @property {string|null} path where it lives when it is not a URL, e.g. a vault note
 * @property {string|null} title what to call it
 * @property {string|null} hash the content hash at the moment it was read
 */

/** How a provider is asked for what it holds, and how it reads it back. */

/**
 * The crawl: the site's own pages, as the crawler rendered them to Markdown.
 *
 * Keyed on the crawler's `urlHash` rather than on the URL, so a citation survives a URL being
 * written with or without a trailing slash and so the ledger key is a fixed width.
 *
 * @param {import("mongodb").Db} database connected database
 */
export function createCrawlSourceProvider(database) {
  const markdown = database.collection(AGENT_COLLECTIONS.markdown);

  /** The crawl site a reference resolves against; without one the provider holds nothing. */
  function siteOf(scope) {
    return scope?.siteId ? toObjectId(scope.siteId) : null;
  }

  return {
    kind: LIBRARY_SOURCE_KINDS.page,

    /**
     * Lists the pages this workspace's crawl holds.
     *
     * @param {{siteId?: unknown}} scope the run's scope
     * @param {{search?: string, limit?: number}} [filter]
     * @returns {Promise<SourceReference[]>}
     */
    async list(scope, { search = "", limit = 500 } = {}) {
      const siteId = siteOf(scope);
      if (!siteId) return [];
      const query = { siteId };
      if (search) {
        const pattern = new RegExp(escapeRegExp(search), "i");
        query.$or = [{ url: pattern }, { title: pattern }];
      }
      const rows = await markdown
        .find(query)
        .project({ url: 1, urlHash: 1, title: 1, heading: 1, hash: 1 })
        .limit(limit)
        .toArray();
      return rows.map(toPageReference);
    },

    /**
     * Resolves what a caller wrote — an exact URL, or the crawler's own key — to references.
     *
     * Accepting both is what keeps the tools usable: a model has URLs in front of it from
     * `content.listPages`, while the ledger and stored citations carry keys.
     *
     * @param {{siteId?: unknown}} scope the run's scope
     * @param {readonly string[]} refs URLs or keys
     * @returns {Promise<{resolved: SourceReference[], unknown: string[]}>}
     */
    async resolve(scope, refs) {
      const siteId = siteOf(scope);
      if (!siteId || !refs.length) return { resolved: [], unknown: [...refs] };
      const rows = await markdown
        .find({ siteId, $or: [{ url: { $in: [...refs] } }, { urlHash: { $in: [...refs] } }] })
        .project({ url: 1, urlHash: 1, title: 1, heading: 1, hash: 1 })
        .toArray();
      const byRef = new Map();
      for (const row of rows) {
        byRef.set(row.url, row);
        byRef.set(row.urlHash, row);
      }
      const resolved = [];
      const unknown = [];
      const seen = new Set();
      for (const ref of refs) {
        const row = byRef.get(ref);
        if (!row) {
          unknown.push(ref);
          continue;
        }
        if (seen.has(row.urlHash)) continue;
        seen.add(row.urlHash);
        resolved.push(toPageReference(row));
      }
      return { resolved, unknown };
    },

    /**
     * Reads the text of several sources.
     *
     * @param {{siteId?: unknown}} scope the run's scope
     * @param {readonly string[]} keys provider keys
     * @returns {Promise<Array<SourceReference & {markdown: string, words: number}>>}
     */
    async read(scope, keys) {
      const siteId = siteOf(scope);
      if (!siteId || !keys.length) return [];
      const rows = await markdown.find({ siteId, urlHash: { $in: [...keys] } }).toArray();
      return rows.map((row) => ({ ...toPageReference(row), markdown: row.markdown ?? "", words: row.words ?? 0 }));
    },
  };
}

/**
 * Prose from outside the website: a Notion page, a vault note, a meeting note.
 *
 * Nothing writes `source_documents` yet — connectors are deliberately out of scope — but the
 * provider exists so that the day one does, the Library tools, the ledger and the API are already
 * able to cite it. The alternative, adding the kind when the first connector lands, would mean
 * changing every one of those at once and re-keying a ledger with real verdicts in it.
 *
 * @param {import("mongodb").Db} database connected database
 */
function createDocumentSourceProvider(database) {
  const documents = database.collection(AGENT_COLLECTIONS.sourceDocuments);

  return {
    kind: LIBRARY_SOURCE_KINDS.document,

    async list(scope, { search = "", limit = 500 } = {}) {
      const query = { workspaceId: toObjectId(scope.workspaceId) };
      if (search) {
        const pattern = new RegExp(escapeRegExp(search), "i");
        query.$or = [{ title: pattern }, { path: pattern }];
      }
      const rows = await documents.find(query).project({ markdown: 0 }).limit(limit).toArray();
      return rows.map(toDocumentReference);
    },

    async resolve(scope, refs) {
      if (!refs.length) return { resolved: [], unknown: [] };
      const rows = await documents
        .find({ workspaceId: toObjectId(scope.workspaceId), key: { $in: [...refs] } })
        .project({ markdown: 0 })
        .toArray();
      const byKey = new Map(rows.map((row) => [row.key, row]));
      const resolved = [];
      const unknown = [];
      for (const ref of refs) {
        const row = byKey.get(ref);
        if (row) resolved.push(toDocumentReference(row));
        else unknown.push(ref);
      }
      return { resolved, unknown };
    },

    async read(scope, keys) {
      if (!keys.length) return [];
      const rows = await documents
        .find({ workspaceId: toObjectId(scope.workspaceId), key: { $in: [...keys] } })
        .toArray();
      return rows.map((row) => ({ ...toDocumentReference(row), markdown: row.markdown ?? "", words: row.words ?? 0 }));
    },
  };
}

/**
 * Every provider this deployment has, keyed by kind.
 *
 * Built per caller rather than as a module-level singleton, because a provider closes over a
 * database handle and the API, the worker and a CLI each have their own.
 *
 * @param {import("mongodb").Db} database connected database
 */
export function createSourceProviders(database) {
  const providers = [createCrawlSourceProvider(database), createDocumentSourceProvider(database)];
  return Object.freeze(Object.fromEntries(providers.map((provider) => [provider.kind, provider])));
}

/**
 * Turns what a caller cited into stored references, refusing anything nobody has seen.
 *
 * A citation that cannot be resolved is refused rather than stored. The file would otherwise carry
 * a reference that looks like evidence and is not, and the writer — a model, usually — is in a
 * position to fix it now rather than leaving a person to discover it months later.
 *
 * @param {object} options
 * @param {Record<string, object>} options.providers providers keyed by kind
 * @param {{workspaceId: unknown, siteId?: unknown}} options.scope whose sources these are
 * @param {ReadonlyArray<{kind: string, ref: string}>} options.sources what was cited
 * @returns {Promise<SourceReference[]>}
 * @throws {LibraryError} `UNKNOWN_SOURCE`, naming what could not be resolved
 */
export async function resolveSourceReferences({ providers, scope, sources }) {
  if (!sources.length) return [];

  const byKind = new Map();
  for (const source of sources) {
    // The crawl is what a citation means unless it says otherwise. Defaulting here rather than
    // only in each caller's validator is what keeps one rule: the store is the boundary, and a
    // caller that wrote `{ref}` meant a page of this site.
    const kind = source.kind ?? LIBRARY_SOURCE_KINDS.page;
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(source.ref);
  }

  const resolved = [];
  const unknown = [];
  for (const [kind, refs] of byKind) {
    const provider = providers[kind];
    if (!provider) {
      unknown.push(...refs.map((ref) => `${kind}:${ref}`));
      continue;
    }
    const answer = await provider.resolve(scope, refs);
    resolved.push(...answer.resolved);
    unknown.push(...answer.unknown);
  }

  if (unknown.length) {
    throw new LibraryError({
      code: LIBRARY_ERROR_CODES.unknownSource,
      message:
        `These sources are not things this workspace holds: ${unknown.slice(0, 10).join(", ")}. ` +
        "Cite the exact URLs content.listPages returned, and nothing you have not read.",
      detail: { unknown: unknown.slice(0, 50) },
    });
  }
  return resolved;
}

/** A crawled page as a source reference. */
function toPageReference(row) {
  return {
    kind: LIBRARY_SOURCE_KINDS.page,
    key: row.urlHash,
    url: row.url ?? null,
    path: null,
    // The page's H1 when the served HTML carried no <title>: a citation labelled by its heading
    // is one a person can recognise in the "written from" list.
    title: row.title ?? row.heading ?? null,
    hash: row.hash ?? null,
  };
}

/** A stored prose document as a source reference. */
function toDocumentReference(row) {
  return {
    kind: LIBRARY_SOURCE_KINDS.document,
    key: row.key,
    url: row.url ?? null,
    path: row.path ?? null,
    title: row.title ?? null,
    hash: row.hash ?? null,
  };
}
