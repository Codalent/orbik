"use client";

import { useParams } from "next/navigation";
import { Suspense } from "react";

import { CrawlDashboard } from "@/components/crawl/CrawlDashboard";

/**
 * One source's Pages tab: the crawl page, for that source. Suspense because it reads the
 * address's query, which says which finding is listed.
 */
export default function SourcePagesView() {
  const { workspaceId, sourceId } = useParams();
  return (
    <Suspense fallback={null}>
      <CrawlDashboard workspaceId={workspaceId} sourceId={sourceId} />
    </Suspense>
  );
}
