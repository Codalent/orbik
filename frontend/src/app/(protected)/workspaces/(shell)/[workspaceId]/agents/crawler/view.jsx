"use client";

import { useParams } from "next/navigation";

import { CrawlDashboard } from "@/components/crawl/CrawlDashboard";

/**
 * The Crawler's page: the crawl the rest of Orbik is built on.
 *
 * The identifier is read on the client rather than awaited from server-side `params`. Awaiting
 * `params` opts the route into per-request server rendering, which measurably delayed first paint
 * for a page whose content is loaded from the API by the browser anyway.
 */
export default function CrawlerView() {
  const { workspaceId } = useParams();
  return <CrawlDashboard workspaceId={workspaceId} />;
}
