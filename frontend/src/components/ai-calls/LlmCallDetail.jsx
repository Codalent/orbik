"use client";

import { useId, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowUpRight, Copy } from "lucide-react";

import {
  MISSING,
  costBreakdown,
  describeBackend,
  describeCostBasis,
  describeDuration,
  describePurpose,
  describeSource,
  formatClock,
  formatCost,
  formatCount,
  formatRate,
  formatStarted,
  runHref,
} from "@/lib/aiCalls/describe";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const TABS = Object.freeze([
  { key: "prompt", label: "Prompt" },
  { key: "system", label: "System" },
  { key: "response", label: "Response" },
  { key: "tools", label: "Tool calls" },
]);

/**
 * One call, opened: who was asked, what it cost line by line, and the words both ways.
 *
 * Everything but the words comes from the row, so the facts and the cost show at once; the prompt,
 * system prompt and reply arrive with the call's own request and say "Loading" until they do.
 *
 * @param {object} props
 * @param {object} props.call the row
 * @param {object|null} props.detail the full call, `{failed}` when it could not be read, or null
 *   while it loads
 * @param {string} props.workspace the workspace's name
 * @param {string} props.tab the open tab
 * @param {(tab: string) => void} props.onTab
 * @param {React.ElementType} [props.Title] the heading element, so a sheet can name itself by it
 */
export function LlmCallDetail({ call, detail, workspace, tab, onTab, Title = "h2" }) {
  const [copied, setCopied] = useState("");
  const tabIds = useId();
  const tabRefs = useRef({});
  const title = describePurpose(call);
  const href = runHref(call);
  const { lines, difference } = costBreakdown(call);
  const loaded = detail && !detail.failed ? detail : null;
  const toolCalls = call.toolCalls ?? [];

  async function copy() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(loaded ?? call, null, 2));
      setCopied(loaded ? "Copied this call as JSON." : "Copied the row as JSON; the prompt and reply had not loaded.");
    } catch {
      setCopied("Copy is unavailable here.");
    }
  }

  /** Arrow keys move between tabs, as a tab list is expected to. */
  function onTabKey(event, index) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = TABS[(index + step + TABS.length) % TABS.length];
    onTab(next.key);
    tabRefs.current[next.key]?.focus();
  }

  const facts = [
    { label: "Requested model", value: call.model?.requested, mono: true },
    { label: "Answered by", value: call.model?.used, mono: true },
    { label: "Provider", value: describeBackend(call.backend) },
    { label: "Effort", value: call.effort },
    { label: "Started", value: formatStarted(call.startedAt) },
    { label: "Duration", value: describeDuration(call) },
    { label: "Turns", value: Number.isFinite(call.turns) ? formatCount(call.turns) : null },
    { label: "Run", value: call.runId, mono: true },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Title className="font-display text-base leading-6 font-bold tracking-[-0.01em] text-orb-white [overflow-wrap:anywhere]">{title}</Title>
          <p className="text-xs leading-4 text-orb-muted">{workspace} · {describeSource(call)} · {formatClock(call.startedAt)}</p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button type="button" variant="outline" size="sm" onClick={copy} aria-label="Copy this call as JSON">
            <Copy aria-hidden="true" className="size-3.5" />
            JSON
          </Button>
          {href && (
            <Link href={href} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Open run
              <ArrowUpRight aria-hidden="true" className="size-3.5" />
            </Link>
          )}
        </div>
      </div>
      <p role="status" className={cn("-mt-3 text-xs text-orb-muted", !copied && "sr-only")}>{copied}</p>

      {call.status === "failed" && (
        <div role="alert" className="flex gap-2.5 rounded-lg border border-orb-coral/40 bg-orb-coral/10 px-3.5 py-3">
          <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-orb-coral" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-mono text-xs break-all text-orb-coral">{call.error?.code ?? "FAILED"}</span>
            <span className="text-compact leading-5 break-words text-orb-white">{call.error?.message || "No message was recorded."}</span>
          </div>
        </div>
      )}

      <dl className="grid grid-cols-2 gap-x-5 gap-y-3">
        {facts.map((fact) => (
          <div key={fact.label} className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-xs leading-4 text-orb-muted">{fact.label}</dt>
            <dd className={cn("truncate text-compact leading-5 text-orb-white tabular-nums", fact.mono && "font-mono text-xs leading-5")} title={fact.value ?? undefined}>
              {fact.value ?? MISSING}
            </dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-col gap-2">
        <p className="text-2xs leading-4 font-medium tracking-[0.12em] text-orb-muted uppercase">Cost</p>
        <div className="overflow-hidden rounded-lg border border-orb-line bg-orb-space/50 text-compact leading-5 tabular-nums">
          {lines.map((line) => (
            <CostLine
              key={line.label}
              label={line.label}
              math={line.amount === null ? MISSING : `${formatCount(line.tokens)} × ${formatRate(line.rate)}`}
              amount={line.amount === null ? MISSING : formatCost(line.amount)}
            />
          ))}
          {difference !== null && (
            <CostLine
              label="Difference"
              math="recorded total, less these lines"
              amount={`${difference > 0 ? "+" : "−"}${formatCost(Math.abs(difference))}`}
            />
          )}
          <div className="grid grid-cols-[96px_minmax(0,1fr)_72px] gap-3 bg-orb-raised/70 px-3 py-2.5">
            <span className="font-semibold text-orb-white">Total</span>
            <span className="text-orb-muted">{describeCostBasis(call)}</span>
            <span className="text-right font-semibold text-orb-white">{formatCost(call.costUsd)}</span>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        <div role="tablist" aria-label="What was sent and received" className="flex max-w-full gap-0.5 self-start overflow-x-auto rounded-full border border-orb-line bg-orb-space/70 p-[3px]">
          {TABS.map((entry, index) => (
            <button
              key={entry.key}
              ref={(element) => { tabRefs.current[entry.key] = element; }}
              type="button"
              role="tab"
              id={`${tabIds}-${entry.key}`}
              aria-selected={entry.key === tab}
              aria-controls={`${tabIds}-panel`}
              tabIndex={entry.key === tab ? 0 : -1}
              onClick={() => onTab(entry.key)}
              onKeyDown={(event) => onTabKey(event, index)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-compact font-medium whitespace-nowrap transition-colors",
                entry.key === tab ? "bg-orb-raised text-orb-white shadow-sm" : "text-orb-gray hover:text-orb-white",
              )}
            >
              {entry.label}
              {entry.key === "tools" && <span className="text-2xs text-orb-muted tabular-nums">{toolCalls.length}</span>}
            </button>
          ))}
        </div>

        <div role="tabpanel" id={`${tabIds}-panel`} aria-labelledby={`${tabIds}-${tab}`}>
          {tab === "tools" ? (
            <ToolCalls toolCalls={toolCalls} />
          ) : (
            <CallText call={call} detail={detail} tab={tab} />
          )}
        </div>
      </div>
    </div>
  );
}

function CostLine({ label, math, amount }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)_72px] gap-3 border-b border-orb-line/70 px-3 py-2">
      <span className="text-orb-gray">{label}</span>
      <span className="truncate text-orb-muted">{math}</span>
      <span className="text-right text-orb-white">{amount}</span>
    </div>
  );
}

/** The prompt, the system prompt, or the reply, with a line saying how long it is. */
function CallText({ call, detail, tab }) {
  let text;
  let meta = "";
  if (!detail) {
    text = "Loading…";
  } else if (detail.failed) {
    text = detail.failed;
  } else if (tab === "prompt") {
    text = detail.prompt ?? "None.";
    if (detail.prompt) {
      meta = call.purpose === "embedding" && call.usage
        ? `${formatCount(call.inputs)} inputs · ${formatCount(call.usage.inputTokens)} tokens`
        : `${formatCount(detail.prompt.length)} characters`;
    }
  } else if (tab === "system") {
    text = detail.system ?? "No system prompt was sent.";
    if (detail.system) meta = `${formatCount(detail.system.length)} characters · sent as the system prompt`;
  } else {
    text = detail.response ?? (call.status === "running" ? "No response yet. The call is still running." : "No response.");
    if (detail.response && call.purpose !== "embedding") {
      meta = `${formatCount(detail.response.length)} characters${call.usage ? ` · ${formatCount(call.usage.outputTokens)} output tokens` : ""}`;
    } else if (call.purpose === "embedding") {
      meta = "Vectors are written to the index, not to this log.";
    }
  }
  if (typeof text === "string" && text.includes("\n… [truncated: ")) meta = `${meta ? `${meta} · ` : ""}clipped when it was logged`;

  return (
    <div className="flex flex-col gap-1.5">
      <pre className="h-[300px] overflow-auto rounded-lg border border-orb-line bg-orb-space/70 px-3.5 py-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-orb-gray">
        {text}
      </pre>
      {meta && <p className="text-xs text-orb-muted tabular-nums">{meta}</p>}
    </div>
  );
}

/** The Orbik tools the model called, in order, each with what it reported. */
function ToolCalls({ toolCalls }) {
  if (!toolCalls.length) return <p className="flex min-h-[300px] items-start rounded-lg border border-dashed border-orb-line px-4 py-6 text-compact text-orb-muted">No tools were called.</p>;
  return (
    <ol className="flex max-h-[300px] min-h-[300px] flex-col gap-2 overflow-y-auto">
      {toolCalls.map((entry, index) => (
        <li key={`${entry.tool}-${index}`} className="flex flex-col gap-1 rounded-lg border border-orb-line bg-orb-space/50 px-3 py-2.5">
          <span className="flex justify-between gap-3">
            <span className="truncate font-mono text-xs text-orb-cyan">{entry.tool}</span>
            <span className="shrink-0 text-xs text-orb-muted tabular-nums">#{index + 1}</span>
          </span>
          <span className="text-compact leading-5 text-orb-gray">{entry.summary || MISSING}</span>
        </li>
      ))}
    </ol>
  );
}
