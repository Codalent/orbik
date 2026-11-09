"use client";

import { useState } from "react";
import { Activity, MessageCircleQuestion, SearchX, Users } from "lucide-react";
import useSWR from "swr";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { EmptyState, Panel, PanelTitle, RowList } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { StatTile } from "@/components/ui/stat-tile";
import * as mcpApi from "@/lib/api/mcp";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The windows the report can cover, in days; the API keeps 90. */
const WINDOWS = Object.freeze([7, 30, 90]);

/**
 * "What your AI asked": what the AIs connected to this workspace did here, from the MCP call log.
 *
 * The part worth reading is the list of questions, the ones the knowledge base answered least well
 * first: every search that came back with nothing, then the rest by how close the best passage
 * came. That is the Library's to-do list, and — when the site never says it either — a page the
 * site is missing. Under it, which tools and which clients are used at all.
 *
 * Shown to admins and the owner, the only roles the API answers for it: the questions are every
 * member's AI's, so the list names the client each came through, never the person.
 *
 * @param {object} props
 * @param {string} props.workspaceId the workspace whose report this is
 */
export function AiQuestions({ workspaceId }) {
  const [days, setDays] = useState(30);
  const { data, error } = useSWR(mcpApi.mcpUsagePath(workspaceId, days), { keepPreviousData: true });

  return (
    <Panel className="space-y-4">
      <PanelTitle aside={<WindowChoice days={days} onChange={setDays} />}>What your AI asked</PanelTitle>
      <p className="-mt-2 text-xs leading-relaxed text-orb-gray">
        Every question an AI connected to this workspace searched it with, and how well it was answered. What it
        answered least well is what to add to the Library, and often a page the site is missing.
      </p>

      {!data && error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error.message ?? "The report could not be loaded. Try again."}</AlertDescription>
        </Alert>
      )}
      {!data && !error && <ReportSkeleton />}
      {data && <Report report={data} />}
    </Panel>
  );
}

/** The figures, the questions, and the tools and clients, for one window. */
function Report({ report }) {
  if (!report.calls) {
    return (
      <EmptyState icon={MessageCircleQuestion}>
        Nothing has asked this workspace anything in the last {report.days} days. Once an AI connected above searches
        it, its questions show here.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile icon={Activity} label="Tool calls" value={report.calls} detail={report.failed ? `${report.failed} refused or failed` : "none failed"} />
        <StatTile icon={MessageCircleQuestion} label="Questions" value={report.questionsAsked} detail="searches it answered" />
        <StatTile
          icon={SearchX}
          label="Found nothing"
          value={report.questionsEmpty}
          tone={report.questionsEmpty ? "attention" : null}
          detail="searches with no passage at all"
        />
        <StatTile icon={Users} label="Clients" value={report.clients.length} detail={report.lastCallAt ? `last call ${formatDate(report.lastCallAt)}` : null} />
      </div>

      <section className="space-y-2" aria-labelledby="ai-questions-heading">
        <h4 id="ai-questions-heading" className="text-compact font-medium text-orb-white">Answered least well</h4>
        {report.questions.length ? (
          <RowList aria-label="Questions, answered least well first">
            {report.questions.map((question) => (
              <QuestionRow key={`${question.query}-${question.lastAskedAt}`} question={question} />
            ))}
          </RowList>
        ) : (
          <EmptyState>No searches in this window. The calls above read files and pages directly.</EmptyState>
        )}
        <p className="text-xs leading-relaxed text-orb-muted">
          Nothing found first, then by how close the best passage came, from 0 to 1, lowest first. A search across
          several workspaces at once is counted above but not listed. Calls are kept for {report.keptDays} days.
        </p>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="space-y-2" aria-labelledby="ai-tools-heading">
          <h4 id="ai-tools-heading" className="text-compact font-medium text-orb-white">Tools</h4>
          <RowList aria-label="Tools used">
            {report.tools.map((tool) => (
              <li key={tool.tool} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 sm:px-4">
                <code className="min-w-[8rem] flex-1 break-all font-mono text-xs text-orb-white">{tool.tool}</code>
                {tool.failed > 0 && <span className="text-xs text-orb-muted">{tool.failed} failed</span>}
                <span className="text-compact tabular-nums text-orb-gray">{tool.calls}</span>
              </li>
            ))}
          </RowList>
        </section>
        <section className="space-y-2" aria-labelledby="ai-clients-heading">
          <h4 id="ai-clients-heading" className="text-compact font-medium text-orb-white">Clients</h4>
          <RowList aria-label="Clients used">
            {report.clients.map((client) => (
              <li key={`${client.kind}-${client.client}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 sm:px-4">
                <span className="min-w-[8rem] flex-1 break-words text-sm text-orb-white">{client.client ?? "Unnamed"}</span>
                <Pill tone="muted">{client.kind === "oauth" ? "App" : "Token"}</Pill>
                <span className="text-compact tabular-nums text-orb-gray">{client.calls}</span>
              </li>
            ))}
          </RowList>
        </section>
      </div>
    </div>
  );
}

/** One question: what was asked, how often and through what, and how well it was answered. */
function QuestionRow({ question }) {
  const empty = question.hits === 0;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 sm:px-4">
      <span className="min-w-[11rem] flex-1">
        <span className="block break-words text-sm text-orb-white">{question.query}</span>
        <span className="mt-0.5 block text-xs text-orb-muted">
          {question.times === 1 ? "Asked once" : `Asked ${question.times} times`}, last {formatDate(question.lastAskedAt, { time: false })}
          {question.clients.length ? ` · ${question.clients.join(", ")}` : ""}
        </span>
      </span>
      {empty ? (
        <Pill tone="orange">Nothing found</Pill>
      ) : (
        <Pill tone="neutral" title="How close the best passage came, from 0 to 1">
          Best match {question.topScore === null ? "–" : question.topScore.toFixed(2)}
        </Pill>
      )}
    </li>
  );
}

/** Which window the report covers: the last 7, 30 or 90 days. */
function WindowChoice({ days, onChange }) {
  return (
    <div role="group" aria-label="How far back" className="flex gap-1 rounded-[10px] border border-orb-line p-0.5">
      {WINDOWS.map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={days === value}
          onClick={() => onChange(value)}
          className={cn(
            "rounded-[7px] px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
            days === value ? "bg-orb-raised text-orb-white" : "text-orb-muted hover:text-orb-white",
          )}
        >
          {value} days
        </button>
      ))}
    </div>
  );
}

/** The figures and a few question rows, while the report is on the way. */
function ReportSkeleton() {
  return (
    <SkeletonRegion label="Loading what your AI asked">
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, tile) => (
            <Skeleton key={tile} className="h-[6.25rem] rounded-xl" />
          ))}
        </div>
        <RowList>
          {Array.from({ length: 3 }, (_, row) => (
            <li key={row} className="space-y-1.5 px-3 py-3 sm:px-4">
              <Skeleton className={row % 2 ? "h-4 w-64 max-w-full" : "h-4 w-80 max-w-full"} />
              <Skeleton className="h-3 w-40" />
            </li>
          ))}
        </RowList>
      </div>
    </SkeletonRegion>
  );
}
