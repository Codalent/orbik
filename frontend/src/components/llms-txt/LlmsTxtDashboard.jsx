"use client";

import { useCallback } from "react";
import { Download, FileCode2 } from "lucide-react";
import useSWR from "swr";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/ui/page-header";
import { EmptyState, Panel, PanelTitle } from "@/components/ui/panel";
import { StatTile } from "@/components/ui/stat-tile";
import { CopyButton } from "@/components/brand/CopyButton";
import { AgentHead, AgentPageSkeleton, AgentStats, CrawlerLink } from "@/components/agents/AgentPage";
import { SourceLedger } from "@/components/agents/SourceLedger";
import { llmsDocumentPath } from "@/lib/api/knowledge";
import { formatDate, pathOf } from "@/lib/format";
import { ago } from "@/lib/home/home";
import { LLMS_TXT_AGENT_SLUG } from "@/lib/knowledge/knowledge";

/**
 * The llms.txt agent's page.
 *
 * The file is the product, so the file is the page: it is shown as written, with the two actions
 * anybody wants — copy it, or save it — and one line saying where it goes. The parsed sections
 * below are not a second copy of the file; they are proof that what is above it parses as llms.txt
 * and that every link points somewhere real.
 *
 * @param {object} props
 * @param {string} props.workspaceId
 */
export function LlmsTxtDashboard({ workspaceId }) {
  const { data: state = null, error: failure, mutate } = useSWR(llmsDocumentPath(workspaceId));

  /** Re-reads the file after a run, which is the one thing that rewrites it. */
  const refresh = useCallback(() => { mutate(); }, [mutate]);

  if (!state && !failure) return <AgentPageSkeleton label="Loading llms.txt" stats={3} />;

  // Said only while there is no file to show; a failed re-read leaves the last one on screen.
  const error = state ? null : failure?.message ?? "The llms.txt file could not be loaded.";

  const document = state?.document ?? null;
  const ready = (state?.readiness?.markdownPages ?? 0) > 0;
  const failedRun = state?.latestRun?.status === "failed" ? state.latestRun : null;

  function download() {
    if (!document) return;
    const blob = new Blob([document.content], { type: "text/markdown;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const anchor = window.document.createElement("a");
    anchor.href = href;
    anchor.download = "llms.txt";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  return (
    <div className="space-y-8">
      <AgentHead
        workspaceId={workspaceId}
        agentSlug={LLMS_TXT_AGENT_SLUG}
        onFinished={refresh}
        fallbackName="llms.txt"
        fallbackSummary="A short map of your site, written for language models to read."
        cadence="once a week"
        ready={ready}
        error={error}
        notReadyMessage="This agent chooses from the pages your crawler has rendered. Crawl your site first, then run it."
        notReadyAction={<CrawlerLink workspaceId={workspaceId} />}
      />

      {failedRun && document && (
        <Alert role="alert">
          <AlertDescription>
            The last run failed{failedRun.error?.message ? `: ${failedRun.error.message}` : "."} The file below is
            the one written on {formatDate(document.updatedAt, { time: false })}.
          </AlertDescription>
        </Alert>
      )}

      {!document ? (
        <EmptyState icon={FileCode2}>
          {ready
            ? "No file yet. The agent picks the pages of your site worth reading, writes a line about each, and produces a file you publish at /llms.txt. Run it to write the first one."
            : "No file yet. Once your site has been crawled, the agent chooses the pages worth reading and writes the file."}
        </EmptyState>
      ) : (
        <>
          <AgentStats columns={3} data-testid="llms-headline">
            <StatTile label="Links" value={document.links.toLocaleString()} detail="Each one a page the crawler fetched" />
            <StatTile label="Sections" value={document.sections.length.toLocaleString()} detail={document.sections.map((section) => section.name).join(" · ")} />
            <StatTile label="Revision" value={document.revision.toLocaleString()} detail={`Written ${ago(document.updatedAt)}`} />
          </AgentStats>

          <Panel>
            <PanelTitle
              as="h2"
              aside={(
                <span className="flex items-center gap-2">
                  <CopyButton text={document.content} size="sm" variant="ghost" />
                  <Button type="button" variant="ghost" size="sm" onClick={download}>
                    <Download aria-hidden="true" className="size-3.5" /> Download
                  </Button>
                </span>
              )}
            >
              <span className="font-mono">llms.txt</span>
            </PanelTitle>
            <p className="-mt-1 mb-4 text-xs text-orb-muted">
              Publish this at the root of your site, so it answers at <span className="font-mono">/llms.txt</span>.
              {" "}Revision {document.revision}, written {formatDate(document.updatedAt)} ·{" "}
              {document.links.toLocaleString()} link{document.links === 1 ? "" : "s"} in{" "}
              {document.sections.length} section{document.sections.length === 1 ? "" : "s"}.
            </p>
            <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-orb-line bg-orb-space/70 p-4 font-mono text-xs leading-relaxed text-orb-gray">
              {document.content}
            </pre>
          </Panel>

          <section className="space-y-3" aria-labelledby="llms-points-heading">
            <SectionHeading id="llms-points-heading">What it points at</SectionHeading>
            <p className="text-sm text-orb-gray">Every link is a page your crawler actually fetched — the agent cannot write one that is not.</p>
            <Panel className="space-y-4">
              {document.sections.map((section) => (
                <section key={section.name}>
                  <h3 className="text-xs font-medium text-orb-muted">{section.name}</h3>
                  <ul className="mt-1.5 space-y-1">
                    {section.links.map((link) => (
                      <li key={link.url} className="text-sm">
                        <a href={link.url} target="_blank" rel="noreferrer" className="text-orb-gray hover:text-orb-cyan hover:underline">
                          {link.title}
                        </a>
                        <span className="ml-2 break-all font-mono text-xs text-orb-muted">{pathOf(link.url)}</span>
                        {link.description && <p className="text-xs text-orb-muted">{link.description}</p>}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </Panel>
          </section>
        </>
      )}

      {state && (
        <SourceLedger workspaceId={workspaceId} agentSlug={LLMS_TXT_AGENT_SLUG} counts={state.sources} />
      )}
    </div>
  );
}
