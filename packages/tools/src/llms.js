import { AGENT_COLLECTIONS, LLMS_LIMITS } from "@orbik/core";

import { rejectUnknown, requireString } from "./args.js";
import { ToolError, defineTool } from "./registry.js";
import { requireAgentSlug, requireSite, requireWorkspace } from "./scope.js";
import { reviewSourceUrls } from "./sources.js";

/**
 * The llms.txt file: a short, curated map of a site, written for a language model to read.
 *
 * The format is a convention, not a schema, which is exactly why it is parsed and checked here
 * rather than trusted. A file a model wrote freehand can be well-written prose that no llms.txt
 * reader recognises — a missing H1, a section with no links, a link to a page that does not exist
 * — and the person who copies it onto their site has no way to tell. Validating on the way in
 * turns every one of those into a message the agent can act on while it is still working.
 *
 * The strictest check is the one on links. Every link back to the site must be a page the crawler
 * actually fetched and rendered, which makes a hallucinated URL impossible rather than unlikely.
 * Links to other hosts are left alone: a company's repository or status page belongs in its
 * llms.txt and is none of the crawler's business.
 */

/** Matches the file's one and only H1, which has to be its first line. */
const TITLE = /^#\s+(.+?)\s*$/;

/** Matches a section heading. */
const SECTION = /^##\s+(.+?)\s*$/;

/** Matches a heading of any level, for rejecting the ones the format does not use. */
const HEADING = /^(#{1,6})\s+/;

/** Matches the blockquote the format uses for the one-line summary. */
const BLOCKQUOTE = /^>\s?(.*)$/;

/** Matches a link line: `- [Name](url)` with an optional `: description`. */
const LINK_LINE = /^[-*]\s+\[([^\]]+)\]\(([^)\s]+)\)\s*(?::\s*(.*))?$/;

/**
 * Parses an llms.txt file, collecting everything wrong with it.
 *
 * Returns both, always: a file with problems is still parsed as far as it can be, so the reply to
 * the agent can say "three of your links are not pages of this site" and name them, rather than
 * stopping at the first one.
 *
 * @param {string} content the file as written
 * @returns {{document: object, problems: string[]}}
 */
function parseLlmsTxt(content) {
  const problems = [];
  const lines = content.split(/\r?\n/);

  let title = null;
  const summary = [];
  const notes = [];
  const sections = [];
  let current = null;

  for (const [index, line] of lines.entries()) {
    const text = line.trimEnd();
    if (!text.trim()) continue;

    const heading = HEADING.exec(text);
    if (heading) {
      const asTitle = TITLE.exec(text);
      if (asTitle) {
        if (title) {
          problems.push(`Line ${index + 1}: the file must have exactly one "# " title, at the top.`);
          continue;
        }
        title = asTitle[1];
        continue;
      }
      const asSection = SECTION.exec(text);
      if (asSection) {
        if (!title) problems.push(`Line ${index + 1}: the file must begin with "# " and the site's name.`);
        current = { name: asSection[1], links: [] };
        sections.push(current);
        continue;
      }
      problems.push(`Line ${index + 1}: llms.txt uses only "# " for the title and "## " for sections.`);
      continue;
    }

    if (!title) {
      problems.push(`Line ${index + 1}: the file must begin with "# " and the site's name.`);
      continue;
    }

    const quote = BLOCKQUOTE.exec(text);
    if (quote && !current) {
      summary.push(quote[1].trim());
      continue;
    }

    const link = LINK_LINE.exec(text);
    if (link) {
      if (!current) {
        problems.push(`Line ${index + 1}: links must sit under a "## " section heading.`);
        continue;
      }
      current.links.push({
        title: link[1].trim(),
        url: link[2].trim(),
        description: link[3]?.trim() || null,
      });
      continue;
    }

    // Anything else is prose. Before the first section it is the optional detail the format
    // allows; inside one it is a list item that is not a link, which is a mistake worth naming.
    if (current) {
      problems.push(`Line ${index + 1}: a section may only contain links of the form "- [Name](url): description".`);
    } else {
      notes.push(text.trim());
    }
  }

  if (!title) problems.push('The file must begin with "# " and the site\'s name.');
  if (!summary.length) problems.push('The title must be followed by a one-line summary beginning with "> ".');
  if (!sections.length) problems.push('The file must have at least one "## " section of links.');
  for (const section of sections) {
    if (!section.links.length) problems.push(`The "${section.name}" section has no links.`);
  }
  if (sections.length > LLMS_LIMITS.sections) {
    problems.push(`The file must have at most ${LLMS_LIMITS.sections} sections.`);
  }
  const links = sections.reduce((total, section) => total + section.links.length, 0);
  if (links > LLMS_LIMITS.links) problems.push(`The file must have at most ${LLMS_LIMITS.links} links.`);

  return {
    document: { title, summary: summary.join(" "), notes: notes.join("\n"), sections, links },
    problems,
  };
}

/** Compares URLs the way a site does: a trailing slash is not a different page. */
function urlKey(url) {
  return url.replace(/\/+$/, "").toLowerCase();
}

/**
 * Sorts the file's links into the ones that are pages of this site, the ones that claim to be and
 * are not, and the ones that are not URLs at all.
 *
 * Links to other hosts pass without comment: a site's llms.txt may legitimately point at its own
 * repository, its documentation on another domain, or its status page, and none of those are in
 * the crawl. The `onSite` list comes back because writing the file is also what accounts for the
 * pages it links — see the handler.
 */
async function classifySiteLinks(database, siteId, sections) {
  const pages = await database
    .collection(AGENT_COLLECTIONS.markdown)
    .find({ siteId })
    .project({ url: 1 })
    .toArray();

  const hosts = new Set();
  for (const page of pages) {
    try {
      hosts.add(new URL(page.url).host.toLowerCase());
    } catch {
      // A stored URL that no longer parses cannot help identify the site's own host.
    }
  }

  const byKey = new Map(pages.map((page) => [urlKey(page.url), page.url]));
  const onSite = new Set();
  const unknown = [];
  const malformed = [];
  for (const section of sections) {
    for (const link of section.links) {
      let parsed;
      try {
        parsed = new URL(link.url);
      } catch {
        malformed.push(link.url);
        continue;
      }
      if (!["http:", "https:"].includes(parsed.protocol)) {
        malformed.push(link.url);
        continue;
      }
      if (!hosts.has(parsed.host.toLowerCase())) continue;
      const match = byKey.get(urlKey(link.url));
      if (match) onSite.add(match);
      else unknown.push(link.url);
    }
  }
  // The crawler's own spelling of each URL, not the file's, so the ledger keys on the page rather
  // than on however the link happened to be written.
  return { onSite: [...onSite], unknown, malformed };
}

/** Reads the llms.txt file as it currently stands. */
const readLlmsTxt = defineTool({
  name: "llms.read",
  description:
    "Read the llms.txt file this agent maintains for the site, or find out that there is none " +
    "yet. Always call this first: an update should keep the sections that still make sense.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  parseInput(input, errors) {
    rejectUnknown(input, [], errors);
    return {};
  },
  async handler(_input, { database, scope }) {
    const workspaceId = requireWorkspace(scope);
    const document = await database.collection(AGENT_COLLECTIONS.llmsDocuments).findOne({ workspaceId });
    if (!document) return { exists: false };
    return {
      exists: true,
      content: document.content,
      updatedAt: document.updatedAt ? new Date(document.updatedAt).toISOString() : null,
      revision: document.revision ?? 1,
    };
  },
});

/**
 * Replaces the llms.txt file.
 *
 * Whole-file rather than section-by-section, for the same reason Library files are written
 * whole: the file is short by design, and its value is that somebody can read all of it. An agent
 * that could append would produce a file that grows past the point of being readable in one go,
 * which is the one thing llms.txt exists to avoid.
 */
const writeLlmsTxt = defineTool({
  name: "llms.write",
  description:
    "Replace the llms.txt file with the complete text, and record every page it links as accounted " +
    "for. The format is: a single \"# Site name\" " +
    "line, then a one-line \"> summary\", then optional plain paragraphs, then \"## Section\" " +
    "headings whose lines are \"- [Page name](https://exact/url): what it covers\". Every link " +
    "back to this site must be a URL from content.listPages; the call is refused otherwise.",
  inputSchema: {
    type: "object",
    properties: {
      content: { type: "string", description: "The complete file, as Markdown." },
    },
    required: ["content"],
    additionalProperties: false,
  },
  parseInput(input, errors) {
    const source = rejectUnknown(input, ["content"], errors);
    return { content: requireString(source.content, "content", { max: LLMS_LIMITS.content }, errors) };
  },
  async handler(input, { database, scope }) {
    const workspaceId = requireWorkspace(scope);
    const siteId = requireSite(scope);

    requireAgentSlug(scope);
    const { document, problems } = parseLlmsTxt(input.content);
    const { onSite, unknown, malformed } = await classifySiteLinks(database, siteId, document.sections);
    if (malformed.length) {
      problems.push(`These are not absolute http(s) URLs: ${malformed.slice(0, 10).join(", ")}.`);
    }
    if (unknown.length) {
      problems.push(
        `These URLs are on this site but are not pages of it: ${unknown.slice(0, 10).join(", ")}. ` +
        "Use the exact URLs from content.listPages.",
      );
    }
    if (problems.length) {
      throw new ToolError({
        code: "INVALID_LLMS_TXT",
        message: `The file was not written. Fix these and call llms.write again: ${problems.join(" ")}`,
      });
    }

    // Writing the file is what accounts for the pages it links, exactly as writing a Library file
    // accounts for its sources. Leaving it to the agent to report them separately is how the first
    // run of this agent left thirty-three linked pages recorded as never seen, so that the next
    // run would have curated them all over again.
    await reviewSourceUrls({
      database,
      scope,
      urls: onSite,
      relevant: true,
      reason: "Linked from llms.txt.",
    });

    const now = new Date();
    const collection = database.collection(AGENT_COLLECTIONS.llmsDocuments);
    const existing = await collection.findOne({ workspaceId }, { projection: { revision: 1 } });
    await collection.updateOne(
      { workspaceId },
      {
        $set: {
          siteId,
          content: input.content,
          title: document.title,
          summary: document.summary,
          notes: document.notes || null,
          sections: document.sections,
          links: document.links,
          bytes: Buffer.byteLength(input.content, "utf8"),
          updatedAt: now,
          updatedByRunId: scope.runId ?? null,
        },
        $inc: { revision: 1 },
        $setOnInsert: { workspaceId, createdAt: now },
      },
      { upsert: true },
    );

    return {
      action: existing ? "updated" : "created",
      revision: (existing?.revision ?? 0) + 1,
      sections: document.sections.length,
      links: document.links,
      bytes: Buffer.byteLength(input.content, "utf8"),
    };
  },
});

/** Every llms.txt tool, keyed by name. */
export const LLMS_TOOLS = Object.freeze({
  [readLlmsTxt.name]: readLlmsTxt,
  [writeLlmsTxt.name]: writeLlmsTxt,
});
