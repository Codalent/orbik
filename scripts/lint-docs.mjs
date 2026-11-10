/**
 * Checks docs/ the way the docs site (orbik.io/docs) and GitHub will read it, so a broken link is
 * caught in the pull request rather than on the published page.
 *
 * - docs/nav.json names files that exist, each once, and its redirects lead to published pages.
 * - Every relative link and image in a Markdown file under docs/ resolves inside the repository,
 *   and every `#anchor` into a Markdown file names one of its headings, slugged as GitHub does.
 * - A published page (one listed in nav.json) opens with its only `# H1` followed by a paragraph,
 *   which the site uses as the page's description, and carries no raw HTML, which it does not render.
 * - File and folder names are lower-case words joined by hyphens, because they are the addresses.
 *
 * Run with `pnpm lint:docs`; it is part of `pnpm lint`. Exits 1 and lists every problem it found.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import GithubSlugger from "github-slugger";
import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { toString } from "mdast-util-to-string";
import { frontmatter } from "micromark-extension-frontmatter";
import { gfm } from "micromark-extension-gfm";
import { visit } from "unist-util-visit";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = join(root, "docs");
const problems = [];
const report = (file, line, message) =>
  problems.push(`${relative(root, file)}${line ? `:${line}` : ""}: ${message}`);

/** Parses a Markdown file the way GitHub does: GFM, with YAML front matter set aside. */
function parse(file) {
  return fromMarkdown(readFileSync(file, "utf8"), {
    extensions: [gfm(), frontmatter(["yaml"])],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(["yaml"])],
  });
}

const anchorCache = new Map();
/** The anchors GitHub gives a Markdown file's headings: github-slugger, duplicates numbered. */
function anchorsOf(file) {
  if (!anchorCache.has(file)) {
    const slugger = new GithubSlugger();
    const anchors = new Set();
    visit(parse(file), "heading", (node) => anchors.add(slugger.slug(toString(node))));
    anchorCache.set(file, anchors);
  }
  return anchorCache.get(file);
}

function* markdownFiles(dir) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* markdownFiles(path);
    else if (name.endsWith(".md")) yield path;
  }
}

// --- nav.json ---------------------------------------------------------------------------------

const navFile = join(docsDir, "nav.json");
let nav = { sections: [], redirects: {} };
try {
  nav = JSON.parse(readFileSync(navFile, "utf8"));
} catch (error) {
  report(navFile, 0, `is not valid JSON: ${error.message}`);
}

/** The address a docs path is published at, without /docs: `self-hosting/README.md` → `self-hosting`. */
const slugOf = (path) => path.replace(/(^|\/)README\.md$/, "").replace(/\.md$/, "");

const published = new Set();
for (const section of nav.sections ?? []) {
  if (!section.title) report(navFile, 0, "a section has no title");
  for (const entry of section.pages ?? []) {
    const path = typeof entry === "string" ? entry : entry?.path;
    if (!path) {
      report(navFile, 0, `a page in "${section.title}" has no path`);
      continue;
    }
    if (!path.endsWith(".md") || path.startsWith("/") || path.includes("..")) {
      report(navFile, 0, `"${path}" must be a .md path relative to docs/`);
    } else if (!existsSync(join(docsDir, path))) {
      report(navFile, 0, `"${path}" does not exist`);
    }
    if (published.has(path)) report(navFile, 0, `"${path}" is listed twice`);
    published.add(path);
  }
}
const publishedSlugs = new Set([...published].map(slugOf));
for (const [from, to] of Object.entries(nav.redirects ?? {})) {
  const target = slugOf(to.replace(/^\/?docs\/?/, ""));
  if (!publishedSlugs.has(target)) report(navFile, 0, `redirect "${from}" leads to "${to}", which is not a published page`);
  if (publishedSlugs.has(slugOf(from))) report(navFile, 0, `redirect "${from}" would hide a published page`);
}

// --- every Markdown file under docs/ ----------------------------------------------------------

for (const file of markdownFiles(docsDir)) {
  const docPath = relative(docsDir, file).split(sep).join("/");
  for (const part of docPath.split("/")) {
    if (part !== "README.md" && !/^[a-z0-9]+(-[a-z0-9]+)*(\.md)?$/.test(part)) {
      report(file, 0, `"${part}": name files and folders in lower-case words joined by hyphens`);
    }
  }

  const tree = parse(file);
  const isPublished = published.has(docPath);

  if (isPublished) {
    const blocks = tree.children.filter((node) => node.type !== "yaml");
    const [first, second] = blocks;
    if (first?.type !== "heading" || first.depth !== 1) {
      report(file, first?.position?.start.line, "a published page must open with its # H1");
    }
    if (second?.type !== "paragraph") {
      report(file, second?.position?.start.line, "the H1 must be followed by a paragraph: the site uses it as the description");
    }
    visit(tree, "heading", (node) => {
      if (node.depth === 1 && node !== first) report(file, node.position.start.line, "a page has one # H1");
    });
    visit(tree, "html", (node) => {
      if (!/^<!--[\s\S]*-->$/.test(node.value.trim())) {
        report(file, node.position.start.line, `raw HTML is not rendered on the site: ${node.value.trim().slice(0, 40)}`);
      }
    });
  }

  visit(tree, ["link", "image", "definition"], (node) => {
    const url = node.url ?? "";
    const line = node.position?.start.line;
    if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url)) return; // https:, mailto: and the like
    if (url.startsWith("//")) return;
    if (url.startsWith("/")) {
      report(file, line, `"${url}": use a link relative to this file`);
      return;
    }
    const [rawPath, anchor] = url.split("#");
    let path;
    try {
      path = decodeURIComponent(rawPath);
    } catch {
      report(file, line, `"${url}" is not a valid address`);
      return;
    }
    let target = path ? resolve(dirname(file), path) : file;
    if (target !== root && !target.startsWith(root + sep)) {
      report(file, line, `"${url}" leads outside the repository`);
      return;
    }
    if (!existsSync(target)) {
      report(file, line, `"${url}" does not exist`);
      return;
    }
    if (statSync(target).isDirectory()) {
      if (anchor === undefined) return;
      target = join(target, "README.md");
      if (!existsSync(target)) return;
    }
    if (anchor !== undefined && target.endsWith(".md") && !anchorsOf(target).has(decodeURIComponent(anchor))) {
      report(file, line, `"${url}": ${relative(root, target)} has no heading with the anchor #${anchor}`);
    }
  });
}

if (problems.length) {
  console.error(`docs: ${problems.length} problem(s)\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`docs: ${published.size} published pages and every link checked`);
