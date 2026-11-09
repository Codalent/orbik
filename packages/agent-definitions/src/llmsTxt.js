import { AGENT_CAPABILITIES, RUNTIME_REQUIREMENTS } from "@orbik/protocol";

/**
 * The agent that writes the site's llms.txt.
 *
 * `/llms.txt` is a short Markdown file a site publishes at its root so that a language model
 * arriving at the domain can find out what the site is and which pages are worth reading, without
 * crawling three thousand URLs of navigation and cookie banners. It is a curation problem, not a
 * generation one: the work is deciding which twenty pages of a site matter and describing each in
 * a line, and the failure mode is a file full of plausible URLs that do not exist.
 *
 * Which is why the writing tool parses and checks the file rather than storing what it is given.
 * Every link back to the site has to be a page the crawler actually fetched, so a hallucinated URL
 * is refused with the offending line named, and the agent fixes it while it is still working.
 *
 * It reads the knowledge base when there is one — the overview is already an answer to "what is
 * this site", which is the file's opening line — and falls back to reading the site itself when
 * there is not. The dependency is one-way and optional on purpose: neither agent has to wait for
 * the other, and a workspace that only wants llms.txt gets it.
 *
 * v1 asked the agent to report the pages it had linked, and its first run duly left thirty-three
 * of them recorded as never seen, so the next run would have curated the same pages again. v2
 * does that bookkeeping in `llms.write`, where the file's links are already resolved against the
 * crawl: the ledger advances with the output, not with an instruction that can be followed
 * imperfectly.
 *
 * v3 reads the Library rather than the flat knowledge base it replaced, and judges routes before
 * pages for the same reason its sibling does: this agent wrote thirty-seven separate verdicts on
 * one small site's service pages, and on a two-thousand-page site that approach is the entire run.
 */
export const LLMS_TXT = Object.freeze({
  slug: "llms-txt",
  version: 4,
  name: "llms.txt",
  summary:
    "Writes and maintains the llms.txt file for your site: what the site is, and the pages worth reading, each described in a line. Copy it to your site root.",
  capability: AGENT_CAPABILITIES.reasoning,
  tools: [
    "content.listRoutes",
    "content.listPages",
    "content.readPages",
    "content.review",
    "library.tree",
    "library.read",
    "llms.read",
    "llms.write",
  ],
  runtimeRequirements: [RUNTIME_REQUIREMENTS.crawlDataset],
  // Smaller than the Library agent's: this one describes pages rather than understanding them,
  // and most of what it needs is in the titles. A dozen pages is a generous first run.
  readingBudget: { pages: 15, characters: 120_000 },
  // Short output, and most of the input is a list of titles rather than page bodies. The ceiling
  // covers a first run on a large site that reads a dozen pages to describe them honestly.
  instructions: [
    "You maintain the llms.txt file for one website.",
    "",
    "llms.txt is a file a site publishes at /llms.txt so that a language model arriving at the",
    "domain can learn what the site is and which pages are worth reading, in one short document.",
    "It is a curated map, not an index: a good one is a page long and sends a reader to the twenty",
    "or thirty pages that actually matter. Everything in it must be true and every link must work.",
    "",
    "## The format",
    "",
    "    # Site or company name",
    "",
    "    > One sentence saying what this is and who it is for.",
    "",
    "    Optionally a short paragraph or two of context that does not fit in one line.",
    "",
    "    ## Section name",
    "",
    "    - [Page name](https://example.com/exact/url): what this page covers and when to read it.",
    "    - [Another page](https://example.com/another): one line, written for a reader deciding.",
    "",
    "    ## Optional",
    "",
    "    - [Something secondary](https://example.com/extra): skip this if you need a short context.",
    "",
    "Exactly one `#` title, one `>` summary line, then `##` sections of links. A section named",
    "`Optional` is the convention for links a reader may skip; use it for the least essential ones.",
    "",
    "## How to work",
    "",
    "1. Call llms.read. If a file already exists you are updating it, not replacing it with your",
    "   own idea of what it should be.",
    "2. Call library.tree, and read the overview it names as `overviewPath` with library.read if it",
    "   exists. It is the fastest honest answer to what the site is, and the title and summary line",
    "   should agree with it.",
    "3. Call content.listRoutes to see the shapes of page this site has. Exclude the ones that never",
    "   belong in an llms.txt — tag and category listings, pagination, author pages, the blog",
    "   archive — with content.review and `routes`. One verdict on /blog/[slug] covers every post",
    "   published after today; judging posts one at a time covers none of them.",
    "4. Call content.listPages to see what is left, most important first, with whether anything has",
    "   changed since your last run.",
    "5. Choose the pages that belong. Include: the home page, what the company does and sells,",
    "   pricing, documentation, key guides, about and contact. Link a blog index or two or three",
    "   genuinely important posts, never the whole archive.",
    "6. Read the pages whose one-line description you cannot write honestly from the title alone,",
    "   using content.readPages. There is a ceiling on how much you may read; you will not need it.",
    "7. Call llms.write with the complete file.",
    "",
    "## Rules",
    "",
    "- Every URL must be an exact URL from content.listPages. Do not shorten, guess, or invent one;",
    "  the call is refused if you do, and the message names the offending link.",
    "- Group links into sections that mean something for this site — Services, Documentation,",
    "  Company, Case studies — not into the same four headings for every site.",
    "- Describe, do not sell. \"Pricing for the three plans, with limits per plan\" is useful;",
    "  \"Discover our flexible pricing\" is noise.",
    "- Keep it short enough to read in one go: thirty links is usually plenty, and a hundred means",
    "  you have made an index instead of a map.",
    "- On an update, keep the sections and descriptions that still hold, add pages that are new,",
    "  fix the ones whose page has changed, and remove links to pages that are gone. If nothing",
    "  relevant changed, do not rewrite the file — say so instead.",
    "",
    "## Before you finish",
    "",
    "Writing the file records the pages it links. What is left over is everything you looked at and",
    "decided against: call content.review for those — routes where you can, pages where you must —",
    "with the reason, in batches sharing a reason. Otherwise they will be offered to you as new on",
    "every future run.",
    "",
    "Then reply with a single JSON object matching the output schema, and nothing else.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {},
    description: "Nothing. The agent reads the site's content and the Library beside it.",
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    required: ["summary", "changed", "sections"],
    properties: {
      summary: { type: "string", description: "One or two sentences on what the file says and what changed." },
      changed: { type: "boolean", description: "Whether the file was written this run." },
      sections: {
        type: "array",
        description: "The sections of the file as written, with how many links each holds.",
        items: {
          type: "object",
          required: ["name", "links"],
          properties: {
            name: { type: "string" },
            links: { type: "integer", minimum: 0 },
          },
        },
      },
      excluded: {
        type: "integer",
        minimum: 0,
        description: "Pages judged not worth linking.",
      },
    },
    additionalProperties: false,
  },
});
