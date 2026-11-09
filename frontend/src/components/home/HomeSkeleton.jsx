import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";

/**
 * Home while its one read is on the way: the header, the four figures and the two columns of cards,
 * drawn in the same boxes at the same sizes, so nothing moves when the read answers and the
 * placeholders turn into the page. It shows nothing of the workspace — not even its name — because
 * nothing has been read yet.
 */
export function HomeSkeleton() {
  return (
    <SkeletonRegion
      label="Loading Home"
      className="mx-auto w-full max-w-6xl min-w-0 space-y-6 px-4 pb-14 pt-6 md:px-8 md:pt-8"
      data-testid="home-loading"
    >
      <div className="rounded-2xl border border-orb-line bg-orb-raised/40 px-5 pb-5 pt-5 md:px-7 md:pb-6 md:pt-6">
        <div className="flex items-start gap-4">
          <Skeleton className="size-12 shrink-0 rounded-xl" />
          <div className="min-w-0 flex-1 space-y-2.5 pt-1">
            <Skeleton className="h-6 w-44 max-w-full" />
            <Skeleton className="h-4 w-56 max-w-full" />
          </div>
        </div>
        <div className="mt-6 max-w-2xl">
          <Skeleton className="h-12 w-full rounded-xl" />
          <div className="mt-3 flex flex-wrap gap-2">
            {["w-36", "w-32", "w-40"].map((width) => <Skeleton key={width} className={`h-6 ${width} rounded-full`} />)}
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((tile) => (
            <div key={tile} className="min-w-0 rounded-xl border border-orb-line bg-orb-raised/40 px-4 pb-3.5 pt-3">
              <Skeleton className="h-3.5 w-24 max-w-full" />
              <Skeleton className="mt-2.5 h-8 w-16" />
              <Skeleton className="mt-2.5 h-3 w-28 max-w-full" />
            </div>
          ))}
        </div>

        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-4">
            <CardSkeleton rows={5} />
            <CardSkeleton rows={3} />
          </div>
          <div className="min-w-0 space-y-4">
            <CardSkeleton rows={3} />
            <CardSkeleton rows={2} />
          </div>
        </div>
      </div>
    </SkeletonRegion>
  );
}

/** One of Home's cards: its small heading, then a few lines where its rows will be. */
function CardSkeleton({ rows }) {
  return (
    <div className="min-w-0 rounded-xl border border-orb-line bg-orb-raised/40 px-5 py-4">
      <div className="mb-4 flex items-center gap-2">
        <Skeleton className="size-4 rounded" />
        <Skeleton className="h-4 w-28" />
      </div>
      <div className="space-y-3.5">
        {Array.from({ length: rows }, (_, row) => (
          <div key={row} className="flex items-center gap-3">
            <Skeleton className="size-7 shrink-0 rounded-lg" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className={row % 2 ? "h-3.5 w-1/2" : "h-3.5 w-2/3"} />
              <Skeleton className="h-1 w-full rounded-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
