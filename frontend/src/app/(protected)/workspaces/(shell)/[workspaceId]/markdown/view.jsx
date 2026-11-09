"use client";

import { useParams } from "next/navigation";

import { CrawlMarkdown } from "@/components/crawl/CrawlMarkdown";

/**
 * The site as documents: every crawled page's Markdown, listed and readable.
 *
 * Fills the panel edge to edge rather than sitting in the usual page frame, because it is a
 * two-pane reader — a list and a document — and both want the full height to scroll in.
 */
export default function MarkdownView() {
  const { workspaceId } = useParams();
  return (
    <div className="flex min-h-0 flex-1 flex-col md:overflow-hidden">
      <CrawlMarkdown workspaceId={workspaceId} />
    </div>
  );
}
