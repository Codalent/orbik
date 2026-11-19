"use client";

import { useParams } from "next/navigation";

import { CrawlDashboard } from "@/components/crawl/CrawlDashboard";

/** One source's pages: the crawl page, for that source. */
export default function SourcePagesView() {
  const { workspaceId, sourceId } = useParams();
  return <CrawlDashboard workspaceId={workspaceId} sourceId={sourceId} />;
}
