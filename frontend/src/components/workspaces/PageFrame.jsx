import { cn } from "@/lib/utils";

/**
 * The frame every page inside the workspace panel sits in, other than the crawl view.
 *
 * The panel itself carries no padding: the crawl view wants to use its full width for the tree and
 * draws its own gutters. Everything else — an agent, the settings — is a column of cards that reads
 * best with a gutter and a ceiling on its width, and this is the one place both are decided.
 *
 * @param {object} props
 * @param {string} props.label the page's accessible name
 * @param {string} [props.className]
 */
export function PageFrame({ label, className, children }) {
  return (
    <main aria-label={label} className="flex min-h-0 flex-1 flex-col md:overflow-y-auto">
      <div className={cn("mx-auto w-full max-w-5xl space-y-6 p-6 md:p-8", className)}>{children}</div>
    </main>
  );
}
