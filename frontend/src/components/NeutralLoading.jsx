import { Skeleton } from "@/components/ui/skeleton";

/**
 * Neutral loading state that never renders cached private workspace information.
 *
 * Two shapes, because loading happens in two places. A whole page that has not resolved yet is the
 * page's only landmark and fills the viewport. A panel loading inside a shell that has already
 * rendered is not a landmark at all: nesting one `main` inside another is invalid, and a second
 * viewport-height block inside a laid-out panel is what pushes the surrounding chrome off screen.
 *
 * @param {object} props
 * @param {string} [props.label] accessible name announced while loading
 * @param {boolean} [props.inline] render as a plain region that fills its parent instead of the
 *   page's `main` landmark
 */
export function NeutralLoading({ label = "Loading", inline = false }) {
  const content = (
    <div className="w-full max-w-sm space-y-3 px-6">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-20 w-full" />
    </div>
  );

  if (inline) {
    return (
      <div className="flex flex-1 items-center justify-center" aria-busy="true" aria-label={label} role="status">
        {content}
      </div>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center" aria-busy="true" aria-label={label}>
      {content}
    </main>
  );
}
