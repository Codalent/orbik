"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";

import { NeutralLoading } from "@/components/NeutralLoading";
import { workspaceCrawlerPath } from "@/lib/workspaces/home";

/**
 * The Crawler used to be a page among the agents. What it showed — the crawl of the website — is
 * the website's pages under Sources now, and this address leads there, for the links and
 * bookmarks that still name it.
 */
export default function CrawlerView() {
  const { workspaceId } = useParams();
  const router = useRouter();
  useEffect(() => {
    router.replace(workspaceCrawlerPath(workspaceId));
  }, [router, workspaceId]);
  return <NeutralLoading label="Opening the website's crawl" />;
}
