/**
 * A run's event log, in the words a person reads.
 *
 * The runtimes emit structured progress rather than a spinner, and everything that shows a run —
 * the agent panel's list, the Library's rail — turns the same event into the
 * same sentence here, so two views of one run can never describe it differently.
 */

/** The run statuses after which nothing more happens: a finished run's events never change. */
export const TERMINAL_RUN_STATUSES = Object.freeze(["succeeded", "failed", "cancelled"]);

/** A run's status, in the words a person would use. */
export const RUN_STATUS_LABELS = Object.freeze({
  queued: "Queued",
  running: "Running",
  succeeded: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
});

/** Turns one event into the line a person reads. */
export function describeRunEvent(event) {
  switch (event.type) {
    case "started":
      return "Started";
    case "progress":
      return event.message;
    case "tool-started":
      return `${toolLabel(event.tool)}…`;
    case "tool-completed":
      return event.summary ? `${toolLabel(event.tool)} — ${event.summary}` : toolLabel(event.tool);
    case "completed":
      return "Finished";
    case "failed":
      return event.message;
    case "truncated":
      return "This run produced too many steps to show them all.";
    default:
      return event.type;
  }
}

/** Names a tool the way a person would, rather than by its namespaced identifier. */
function toolLabel(tool) {
  const labels = {
    "crawl.summarize": "Summarizing the crawl",
    "crawl.listPages": "Reading pages",
    "crawl.getInternalLinks": "Checking internal links",
    "content.listRoutes": "Looking at the shape of your site",
    "content.listPages": "Looking at what your site says",
    "content.readPages": "Reading your pages",
    "content.review": "Recording what it decided",
    "content.search": "Searching what your site says",
    "library.tree": "Looking at the Library",
    "library.read": "Opening a Library file",
    "library.search": "Searching the Library",
    "library.mkdir": "Making a folder",
    "library.write": "Writing a Library file",
    "library.move": "Moving a file",
    "library.delete": "Removing a file",
    "knowledge.listPages": "Checking the knowledge base",
    "knowledge.readPage": "Re-reading a knowledge page",
    "knowledge.writePage": "Writing a knowledge page",
    "knowledge.deletePage": "Removing a knowledge page",
    "llms.read": "Reading the current llms.txt",
    "llms.write": "Writing llms.txt",
  };
  return labels[tool] ?? tool;
}
