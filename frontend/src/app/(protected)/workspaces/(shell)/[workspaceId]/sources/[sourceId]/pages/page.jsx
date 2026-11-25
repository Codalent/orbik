import SourcePagesView from "./view";

export const metadata = { title: "Pages" };

/**
 * Every page of one source as its crawl knows them: the tree, the findings, the crawl logs and each
 * page's panel. The website's is where the Crawler's page used to be (`/agents/crawler` leads here).
 */
export default function SourcePagesRoute() {
  return <SourcePagesView />;
}
