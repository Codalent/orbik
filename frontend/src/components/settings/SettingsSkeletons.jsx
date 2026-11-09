import { Panel, RowList } from "@/components/ui/panel";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";

/**
 * The Settings page's sections while their reads are on the way.
 *
 * Each section loads on its own, and each used to stand as one line of "Loading…" until it
 * answered, so the page grew under the reader as the sections arrived and the navigation's anchors
 * landed in the wrong place. These are the same panels and rows at the same sizes, holding
 * placeholders, so a section fills in where it already stands.
 */

/** The workspace's facts: a label and a value per line, as `WorkspaceFacts` draws them. */
export function FactsSkeleton({ rows = 5 }) {
  return (
    <SkeletonRegion label="Loading the workspace">
      <Panel className="p-0 sm:p-0">
        <div className="divide-y divide-orb-line/70">
          {Array.from({ length: rows }, (_, row) => (
            <div key={row} className="grid gap-2 px-4 py-3.5 sm:grid-cols-[13rem_minmax(0,1fr)] sm:items-center sm:gap-4 sm:px-5">
              <Skeleton className="h-4 w-24" />
              <Skeleton className={row % 2 ? "h-4 w-40 max-w-full" : "h-4 w-56 max-w-full"} />
            </div>
          ))}
        </div>
      </Panel>
    </SkeletonRegion>
  );
}

/** The people panel: its heading, then a row per person with an avatar, an address and a role. */
export function MembersSkeleton({ rows = 3 }) {
  return (
    <SkeletonRegion label="Loading members">
      <Panel>
        <Skeleton className="mb-4 h-4 w-20" />
        <RowList>
          {Array.from({ length: rows }, (_, row) => (
            <li key={row} className="flex items-center gap-3 px-3 py-3 sm:px-4">
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <span className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className={row % 2 ? "h-4 w-36 max-w-full" : "h-4 w-48 max-w-full"} />
                <Skeleton className="h-3 w-28" />
              </span>
              <Skeleton className="h-6 w-16 shrink-0 rounded-full" />
            </li>
          ))}
        </RowList>
      </Panel>
    </SkeletonRegion>
  );
}

/** "Orbik MCP": the connected list, then the two ways to connect, each an icon, a heading and a line. */
export function ConnectYourAiSkeleton() {
  return (
    <SkeletonRegion label="Loading connected AI clients" className="space-y-4">
      <Panel>
        <Skeleton className="mb-4 h-4 w-24" />
        <RowList>
          {[0, 1].map((row) => (
            <li key={row} className="flex items-center gap-3 px-3 py-3 sm:px-4">
              <Skeleton className="size-8 shrink-0 rounded-lg" />
              <span className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className={row ? "h-4 w-40 max-w-full" : "h-4 w-56 max-w-full"} />
                <Skeleton className="h-3 w-44 max-w-full" />
              </span>
              <Skeleton className="h-7 w-16 shrink-0 rounded-full" />
            </li>
          ))}
        </RowList>
        <div className="mt-3.5 space-y-1.5">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      </Panel>
      {[0, 1].map((panel) => (
        <Panel key={panel} className="flex items-start gap-3">
          <Skeleton className="size-9 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-64 max-w-full" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-9 w-full rounded-lg" />
          </div>
        </Panel>
      ))}
    </SkeletonRegion>
  );
}
