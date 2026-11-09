/**
 * What a Library run is doing to the Library, read out of the run's own event log.
 *
 * A run reports itself as events, not as a progress document, so this is the whole of what a page
 * can honestly say while one is in flight: which files it has finished writing, and which step it
 * is on. The one place a file's path survives the event boundary is the `tool-completed` summary
 * a Library write produces — "updated /overview" — so that string is parsed here, strictly, and
 * anything that does not match is left alone rather than guessed at.
 *
 * After a run finishes there is something much better: the run's own result lists every node it
 * touched, with the action and the agent's reason. That is what "What changed" shows.
 */

/** The summaries a Library tool produces, as `<action> <path>`. */
const WRITE_SUMMARY = /^(created|updated|deleted|unchanged|skipped) (\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*)$/;

/** How each action reads on a row, and whether it is worth colouring. */
const ACTION_TONE = Object.freeze({
  created: "text-orb-lime",
  updated: "text-orb-lime",
  moved: "text-orb-gray",
  deleted: "text-orb-coral",
  unchanged: "text-orb-muted",
  skipped: "text-orb-muted",
});

/**
 * The three kinds of work a Library run does, and the tools that do each.
 *
 * Grouped by tool rather than by time, because the agent does not work in three steps: it reads
 * the core pages, writes the overview, then searches, reads and writes one subject at a time into
 * the folders the person chose. So a phase is "work of this kind", with a count of how
 * much of it has been done, and the run can be back in a phase it has been in before. Each phase
 * is named three ways, for the three things it can be: not started, happening now, and done.
 */
const PHASES = Object.freeze([
  {
    key: "site",
    todo: "Look at your site",
    doing: "Looking at your site",
    done: "Looked at your site",
    tools: ["library.tree", "content.siteMap", "content.listRoutes", "content.listPages", "crawl.summarize", "crawl.listPages", "crawl.getInternalLinks"],
  },
  {
    key: "read",
    todo: "Read what changed",
    doing: "Reading what changed",
    done: "Read what changed",
    tools: ["content.readPages", "content.search", "library.read", "library.search"],
  },
  {
    key: "write",
    todo: "Update the Library",
    doing: "Updating the Library",
    done: "Updated the Library",
    tools: ["library.write", "library.mkdir", "library.move", "library.delete"],
  },
]);

/** Which phase a tool's work belongs to. */
const PHASE_OF_TOOL = new Map(PHASES.flatMap((phase) => phase.tools.map((tool) => [tool, phase.key])));

/** The tools whose start means a file is being written right now. */
const WRITING_TOOLS = new Set(["library.write", "library.mkdir"]);

/**
 * The files a run in flight has written so far, newest last.
 *
 * @param {Array<object>} events the run's events, oldest first
 * @returns {Array<{path: string, action: string, kind: "file"|"folder", seq: number, at: string|null}>}
 */
function writesSoFar(events) {
  const writes = new Map();
  for (const event of events ?? []) {
    if (event.type !== "tool-completed" || typeof event.summary !== "string") continue;
    if (!String(event.tool ?? "").startsWith("library.")) continue;
    const match = WRITE_SUMMARY.exec(event.summary);
    if (!match) continue;
    const [, action, path] = match;
    if (action === "unchanged" || action === "skipped") continue;
    // A file written twice in one run shows once, as what it ended up being.
    writes.set(path, { path, action, kind: event.tool === "library.mkdir" ? "folder" : "file", seq: event.seq, at: event.at ?? null });
  }
  return [...writes.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * What to put beside a path in the tree, keyed by path.
 *
 * Only while a run is in flight, and only for writes that have finished: the event that starts a
 * write names the tool but not the file, so the file being written now cannot be marked, and the
 * agent announces no plan, so nor can the ones it will write next. Finished writes are in the
 * quiet tone rather than the agent's lime, which on this page means "happening now". Once the run
 * is over the tree says what the Library is, and the record of what the run did belongs in "What
 * changed" rather than scattered down the rail.
 */
export function treeActivity({ events, inFlight }) {
  if (!inFlight) return new Map();
  return new Map(
    writesSoFar(events).map((write) => [
      write.path,
      write.action === "deleted"
        ? { label: "removed", tone: "text-orb-coral" }
        : { label: write.action, tone: "text-orb-gray" },
    ]),
  );
}

/** The tone a change of this kind is written in. */
export function actionTone(action) {
  return ACTION_TONE[action] ?? "text-orb-muted";
}

/**
 * Everything a finished run recorded about the Library, or null if it recorded nothing.
 *
 * The result is only present on a run that succeeded, and only for agents whose output schema says
 * so — the Library agent's does: a summary, the nodes it touched with a reason each, and how many
 * of the site's pages it used and excluded.
 */
export function changesOf(run) {
  const result = run?.result;
  if (!result || typeof result !== "object") return null;
  const nodes = Array.isArray(result.nodes) ? result.nodes : [];
  const written = nodes.filter((node) => node.action !== "unchanged" && node.action !== "skipped");
  return {
    summary: typeof result.summary === "string" ? result.summary : null,
    nodes,
    written,
    unchanged: nodes.length - written.length,
    sources: result.sources ?? null,
    aroundUserContent: Array.isArray(result.aroundUserContent) ? result.aroundUserContent : [],
    openQuestions: Array.isArray(result.openQuestions) ? result.openQuestions : [],
    // What the site has that no folder of the person's structure fits: the run filed nothing for
    // it and says where it would go, for the person to decide.
    unfiled: Array.isArray(result.unfiled) ? result.unfiled.filter((item) => item?.subject) : [],
  };
}

/**
 * A run read as its three kinds of work, with what each has done so far.
 *
 * Every number here is one the run itself reported, in the summary line a tool leaves when it
 * finishes — "4 routes", "72 pages, 3 changed", "2 pages read", "created /pricing" — and a summary
 * that does not match is counted as nothing rather than guessed at. The phase the latest step
 * belongs to is the one happening now; a phase that has had steps shows its count, and is only
 * called done once the run is over, because until then the agent may come back to it.
 *
 * @param {Array<object>} events the run's events, oldest first
 * @param {{inFlight: boolean}} options
 */
export function runPhases(events, { inFlight }) {
  const seen = new Map(PHASES.map((phase) => [phase.key, 0]));
  const counts = { nodes: null, routes: null, listing: null, map: null, read: 0, searches: 0 };
  let current = null;
  let last = null;

  for (const event of events ?? []) {
    if (event.type !== "tool-started" && event.type !== "tool-completed") continue;
    const key = PHASE_OF_TOOL.get(event.tool);
    if (!key) continue;
    current = key;
    last = event;
    if (event.type !== "tool-completed") continue;
    seen.set(key, seen.get(key) + 1);
    const summary = typeof event.summary === "string" ? event.summary : "";
    if (event.tool === "library.tree") counts.nodes = countIn(summary, /^([\d,]+) nodes?$/) ?? counts.nodes;
    else if (event.tool === "content.listRoutes") counts.routes = countIn(summary, /^([\d,]+) routes?$/) ?? counts.routes;
    else if (event.tool === "content.listPages") {
      const listing = parseListing(summary);
      // A listing can be filtered, so the widest one the run made is the one that describes
      // the site rather than one slice of it.
      if (listing && (!counts.listing || listing.total >= counts.listing.total)) counts.listing = listing;
    } else if (event.tool === "content.siteMap") counts.map = summary || counts.map;
    // A page is read through either door: its copy in the Library, or the crawl's own Markdown.
    else if (event.tool === "content.readPages" || event.tool === "library.read") counts.read += countIn(summary, /^([\d,]+) pages? read$/) ?? 0;
    else if (event.tool === "content.search") counts.searches += 1;
  }

  const writes = writesSoFar(events);
  const soFar = inFlight ? " so far" : "";
  const details = {
    site: [
      counts.nodes === null ? null : counts.nodes === 0 ? "an empty Library" : plural(counts.nodes, "Library item"),
      counts.routes === null ? null : plural(counts.routes, "route"),
      counts.map ?? counts.listing?.text ?? null,
    ].filter(Boolean).join(" · "),
    read: [
      counts.read ? plural(counts.read, "page") + " read" : null,
      counts.searches ? plural(counts.searches, "search", "searches") : null,
    ].filter(Boolean).join(" · ") + (counts.read || counts.searches ? soFar : ""),
    write: writes.length ? `${writtenCount(writes)} written${soFar}` : "",
  };

  const phases = PHASES.map((phase) => {
    const steps = seen.get(phase.key);
    const isCurrent = inFlight && phase.key === current;
    let state = "pending";
    if (isCurrent) state = "current";
    else if (steps > 0 || (!inFlight && phase.key === current)) state = inFlight ? "visited" : "done";
    else if (!inFlight) state = "skipped";
    const label = state === "current" ? phase.doing : state === "pending" || state === "skipped" ? phase.todo : phase.done;
    return { key: phase.key, label, doing: phase.doing, state, detail: details[phase.key] };
  });

  const listing = counts.listing;
  const moved = listing ? listing.new + listing.changed : 0;
  return {
    phases,
    current,
    writes,
    // Tools run one at a time, so a write that has started and not finished is the latest event.
    writing: inFlight && last?.type === "tool-started" && WRITING_TOOLS.has(last.tool),
    tiles: listing
      ? [
        { value: moved, label: listing.changed && !listing.new ? "pages changed" : listing.new && !listing.changed ? "new pages" : "new or changed" },
        { value: counts.read, label: counts.read === 1 ? "page read" : "pages read" },
        { value: Math.max(0, listing.total - moved), label: "unchanged, skipped" },
      ]
      : null,
  };
}

/**
 * The one line a run in flight gets in the header: the kind of work it is doing, and how much.
 *
 * Falls back to the latest step in the run's own words while no phase has begun — the first
 * moments of a run, or an agent whose tools are not the Library's.
 */
export function runHeadline(phases) {
  const current = phases.phases.find((phase) => phase.state === "current");
  if (!current) return null;
  if (current.key === "write" && phases.writing) {
    return phases.writes.length ? `Writing a file · ${phases.writes.length.toLocaleString()} written so far` : "Writing a file";
  }
  return current.detail ? `${current.doing} · ${current.detail}` : current.doing;
}

/** The first number a pattern captures from a summary, without its thousands separators. */
function countIn(summary, pattern) {
  const match = pattern.exec(summary);
  if (!match) return null;
  const value = Number(match[1].replaceAll(",", ""));
  return Number.isFinite(value) ? value : null;
}

/** Reads a page listing's summary: "72 pages", or "72 pages, 5 new, 3 changed". */
function parseListing(summary) {
  const match = /^([\d,]+) pages?(?:, (.+))?$/.exec(summary);
  if (!match) return null;
  const total = Number(match[1].replaceAll(",", ""));
  const rest = match[2] ?? "";
  return {
    total,
    new: countIn(rest, /([\d,]+) new/) ?? 0,
    changed: countIn(rest, /([\d,]+) changed/) ?? 0,
    text: summary,
  };
}

/** How many files and folders a run has written, as "19 files and 2 folders". */
function writtenCount(writes) {
  const folders = writes.filter((write) => write.kind === "folder").length;
  const files = writes.length - folders;
  return [files ? plural(files, "file") : null, folders ? plural(folders, "folder") : null].filter(Boolean).join(" and ");
}

/** A count and its noun, in the right number. */
function plural(count, noun, plural = `${noun}s`) {
  return `${count.toLocaleString()} ${count === 1 ? noun : plural}`;
}
