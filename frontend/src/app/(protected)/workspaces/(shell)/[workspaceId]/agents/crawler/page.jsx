import CrawlerView from "./view";

export const metadata = { title: "Crawl" };

/**
 * The Crawler's page, among the other agents' (`workspaceCrawlerPath`). It used to be the
 * workspace's bare address, which now opens Home. The page itself is static; the view reads the
 * workspace from the route.
 */
export default function CrawlerAgentPage() {
  return <CrawlerView />;
}
