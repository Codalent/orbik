"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, CircleAlert, Lock, LoaderCircle } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { ConnectAiStep } from "./ConnectAiStep";
import { STEP_STATE, STEP_TITLES, WAITS_FOR, ago, doneLine, plural, whoCanDo } from "@/lib/home/home";
import { isUnlimited } from "@/lib/crawl/budget";
import { cn } from "@/lib/utils";

/**
 * The setup checklist at the top of Home: **Set up {workspace}**, how many essentials are done,
 * the four essentials in order and the recommended steps under them.
 *
 * Every state comes from the API, which reads it from what the workspace records; nothing here is
 * ticked by hand, so a step done on Settings or by a teammate is done here on the next read. The
 * first essential not done is open, carrying the one button that moves it on; any other step opens
 * when its line is pressed. The steps are drawn as the crawl's setup guide draws its sequence — a
 * column of tiles joined by hairlines, the accent kept for what is done or moving — because they
 * are a sequence: the folders wait for the crawl, and the Library waits for the folders.
 *
 * When every essential is done the card is one line, "Setup complete · 2 recommended left", with
 * Show to open it again; Hide takes it off the page altogether.
 *
 * @param {object} props
 * @param {object} props.home the Home read
 * @param {string|null} props.myEmail the signed-in person's address, to say "you"
 * @param {(change: object) => Promise<void>} props.onPreferences saves a skip or the hidden state
 * @param {() => Promise<void>} props.onRetryCrawl asks for the crawl again
 * @param {() => void} props.onChanged re-reads Home
 */
export function SetupChecklist({ home, myEmail, onPreferences, onRetryCrawl, onChanged }) {
  const workspaceId = home.workspace.id;
  const essentials = home.steps.filter((step) => step.group === "essential");
  const recommended = home.steps.filter((step) => step.group === "recommended");
  const { done, total } = home.progress.essentials;
  const complete = done === total;
  // The step that carries the primary button: the first essential this person can move on.
  const next = essentials.find((step) => step.state !== STEP_STATE.done && step.state !== STEP_STATE.notPermitted) ?? null;

  const [shown, setShown] = useState(false);
  const [opened, setOpened] = useState(null);
  const [recommendedOpen, setRecommendedOpen] = useState(complete);
  const [busy, setBusy] = useState(false);
  const openId = opened ?? next?.id ?? null;
  const toggle = (id) => setOpened(openId === id ? "none" : id);

  async function save(change) {
    setBusy(true);
    try {
      await onPreferences(change);
    } finally {
      setBusy(false);
    }
  }

  const hideButton = (
    <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => save({ hidden: true })} className="text-orb-muted">
      Hide
    </Button>
  );

  if (complete && !shown) {
    const left = home.progress.recommended.left;
    return (
      <section aria-label="Setup" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-orb-line bg-orb-raised/40 px-4 py-2.5">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-orb-lime/15 text-orb-lime">
          <Check aria-hidden="true" className="size-3.5" />
        </span>
        <p className="min-w-0 flex-1 text-sm text-orb-white">
          Setup complete{left > 0 && <span className="text-orb-gray"> · {plural(left, "recommended step")} left</span>}
        </p>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => setShown(true)}>Show</Button>
          {hideButton}
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="home-setup-title" className="rounded-xl border border-orb-line bg-orb-raised/40">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2 px-5 pt-5">
        <div className="min-w-0 flex-1">
          <h2 id="home-setup-title" className="font-display text-xl font-bold tracking-[-0.015em] text-orb-white [overflow-wrap:anywhere]">
            Set up {home.workspace.name}
          </h2>
          <p className="mt-0.5 text-sm text-orb-gray">
            {total ? `${done} of ${total} essentials done` : "Nothing here is yours to do"}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {complete && <Button type="button" variant="ghost" size="sm" onClick={() => setShown(false)}>Collapse</Button>}
          {hideButton}
        </div>
      </div>
      {/* The bar is the same fact as the line above it, drawn: it adds nothing for a screen reader. */}
      <div aria-hidden="true" className="mx-5 mt-3 h-1 overflow-hidden rounded-full bg-orb-line">
        <div className="h-full rounded-full bg-orb-lime transition-[width] duration-500" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
      </div>

      <ol aria-label="Essentials" className="px-5 pt-5">
        {essentials.map((step, index) => (
          <StepRow
            key={step.id}
            step={step}
            number={index + 1}
            last={index === essentials.length - 1}
            open={openId === step.id}
            primary={next?.id === step.id}
            onToggle={() => toggle(step.id)}
            home={home}
            myEmail={myEmail}
            onRetryCrawl={onRetryCrawl}
            onChanged={onChanged}
          />
        ))}
      </ol>

      <div className="border-t border-orb-line px-5 py-3">
        <button
          type="button"
          aria-expanded={recommendedOpen}
          onClick={() => setRecommendedOpen(!recommendedOpen)}
          className="flex w-full items-center gap-2 text-left text-sm font-medium text-orb-white"
        >
          <ChevronDown aria-hidden="true" className={cn("size-4 text-orb-muted transition-transform", !recommendedOpen && "-rotate-90")} />
          Recommended
          <span className="font-normal text-orb-muted">
            · {home.progress.recommended.left ? `${home.progress.recommended.left} left` : "all done or skipped"}
          </span>
        </button>
        {recommendedOpen && (
          <ol aria-label="Recommended" className="pt-4">
            {recommended.map((step, index) => (
              <StepRow
                key={step.id}
                step={step}
                last={index === recommended.length - 1}
                open={openId === step.id}
                onToggle={() => toggle(step.id)}
                home={home}
                myEmail={myEmail}
                busy={busy}
                onSkip={(skipped) => save(skipped ? { skip: [step.id] } : { unskip: [step.id] })}
                onChanged={onChanged}
              />
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

/**
 * One step: its tile, its title and one line of where it stands, and — while open — what to do.
 *
 * The connector to the next tile is drawn by this row, as in the crawl's setup guide, because only
 * this row knows where its own tile ends.
 */
function StepRow({ step, number, last, open, primary = false, onToggle, home, myEmail, busy, onSkip, onRetryCrawl, onChanged }) {
  const title = STEP_TITLES[step.id] ?? step.id;
  const status = statusLine(step, myEmail);
  const bodyId = `home-step-${step.id}`;
  const muted = step.state === STEP_STATE.notPermitted || step.state === STEP_STATE.skipped;

  return (
    <li className="flex gap-3 sm:gap-4">
      <div className="flex flex-col items-center">
        <StepTile state={step.state} number={number} />
        {!last && <span aria-hidden="true" className={cn("w-px flex-1", step.state === STEP_STATE.done ? "bg-orb-lime/40" : "bg-orb-muted/60")} />}
      </div>
      <div className={cn("min-w-0 flex-1", last ? "pb-1" : "pb-5")}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
          className="group flex w-full min-w-0 flex-col items-start pt-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/70 rounded-md"
        >
          <span className={cn("text-sm font-semibold [overflow-wrap:anywhere]", muted ? "text-orb-gray" : "text-orb-white")}>{title}</span>
          <span className={cn("text-compact [overflow-wrap:anywhere]", toneOf(step.state))}>{status}</span>
        </button>
        {open && (
          <div id={bodyId} className="mt-3 min-w-0 space-y-3">
            <StepBody step={step} home={home} primary={primary} onRetryCrawl={onRetryCrawl} onChanged={onChanged} />
            {onSkip && step.state !== STEP_STATE.done && step.permitted && (
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => onSkip(step.state !== STEP_STATE.skipped)} className="text-orb-muted">
                {step.state === STEP_STATE.skipped ? "Bring it back" : "Skip"}
              </Button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/** The tile at the head of a step: its number, a spinner ring, a check, or a warning. */
function StepTile({ state, number }) {
  const base = "flex size-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold";
  if (state === STEP_STATE.done) {
    return <span className={cn(base, "border-orb-lime/50 bg-orb-lime/15 text-orb-lime")}><Check aria-hidden="true" className="size-4" /></span>;
  }
  if (state === STEP_STATE.inProgress) {
    return <span className={cn(base, "border-orb-lime/50 text-orb-lime")}><LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /></span>;
  }
  if (state === STEP_STATE.attention) {
    return <span className={cn(base, "border-orb-coral/60 bg-orb-coral/10 text-orb-coral")}><CircleAlert aria-hidden="true" className="size-4" /></span>;
  }
  if (state === STEP_STATE.notPermitted) {
    return <span className={cn(base, "border-orb-line text-orb-muted")}><Lock aria-hidden="true" className="size-3.5" /></span>;
  }
  return <span className={cn(base, "border-orb-muted/60 bg-orb-space text-orb-gray", state === STEP_STATE.skipped && "border-dashed")}>{number ?? ""}</span>;
}

/** The colour a step's status line is drawn in, by its state. */
function toneOf(state) {
  if (state === STEP_STATE.done || state === STEP_STATE.inProgress) return "text-orb-lime";
  if (state === STEP_STATE.attention) return "text-orb-coral";
  return "text-orb-muted";
}

/** The one line under a step's title: where it stands, in words. */
function statusLine(step, myEmail) {
  const detail = step.detail ?? {};
  if (step.state === STEP_STATE.done) {
    if (step.id === "ai") return `Connected · ${detail.client ?? "your AI"} last called ${ago(detail.lastUsedAt)}`;
    return doneLine(step, myEmail);
  }
  if (step.state === STEP_STATE.skipped) return "Skipped";
  if (step.state === STEP_STATE.notPermitted) return whoCanDo(step.requires);
  if (step.state === STEP_STATE.inProgress) {
    switch (step.id) {
      case "website":
        return detail.queued && !detail.fetched && !detail.discovered
          ? "Queued — the crawl starts within a minute"
          : `Crawling… ${plural(detail.discovered, "page")} found, ${detail.fetched.toLocaleString()} fetched`;
      case "structure": return "Proposing structures…";
      case "library":
        return detail.filesWritten ? `Writing — ${plural(detail.filesWritten, "file")} so far` : detail.copying ? "Copying your pages into Sources…" : "Writing…";
      case "ai": return "Connected, waiting for the first call";
      case "brand": return "Deriving…";
      default: return "In progress…";
    }
  }
  if (step.state === STEP_STATE.attention) return detail.error?.message ? "Needs attention" : "The last attempt failed";
  if (step.waitsFor) return `Waits for ${WAITS_FOR[step.waitsFor] ?? "the step before"}`;
  if (step.id === "library" && detail.working === false) return "Paused — the Library agent is not set to work";
  return "Not started";
}

/** A link styled as a button: it navigates, so it is an anchor, not a button. */
function ActionLink({ href, primary, children }) {
  return (
    <Link href={href} className={cn(buttonVariants({ variant: primary ? "default" : "outline", size: "sm" }))}>
      {children}
    </Link>
  );
}

/** What an open step says and offers, by step. */
function StepBody({ step, home, primary, onRetryCrawl, onChanged }) {
  const id = home.workspace.id;
  const detail = step.detail ?? {};
  const done = step.state === STEP_STATE.done;
  const text = "max-w-[62ch] text-sm leading-relaxed text-orb-gray";
  const libraryHref = `/workspaces/${id}/library`;

  switch (step.id) {
    case "website": {
      // With no monthly limit there is no balance worth quoting in a sentence about cost.
      const budget = detail.budget && !isUnlimited(detail.budget)
        ? `${detail.budget.remaining.toLocaleString()} of your ${detail.budget.allowance.toLocaleString()} pages this month`
        : null;
      if (step.state === STEP_STATE.attention) {
        return (
          <>
            <p className={text}>{detail.error?.message ?? "The last crawl did not finish."}</p>
            <div className="flex flex-wrap gap-2">
              {step.permitted && <Button type="button" size="sm" onClick={onRetryCrawl}>Crawl again</Button>}
              <ActionLink href={`/workspaces/${id}/agents/crawler`}>Open the Crawler</ActionLink>
            </div>
          </>
        );
      }
      return (
        <>
          <p className={text}>
            {done
              ? `Orbik keeps ${detail.host ?? "your site"} up to date on a schedule; the Crawler page shows what it found.`
              : `Orbik reads ${detail.host ?? "your site"} page by page, obeying robots.txt. Each page fetched costs one page of crawl budget${budget ? ` — ${budget} left` : ""}.`}
          </p>
          {step.state === STEP_STATE.notStarted && step.permitted
            ? <ActionLink href={`/workspaces/${id}/agents/crawler`} primary={primary}>Start first crawl</ActionLink>
            : <ActionLink href={`/workspaces/${id}/agents/crawler`}>{step.state === STEP_STATE.inProgress ? "Watch the crawl" : "Open the Crawler"}</ActionLink>}
        </>
      );
    }
    case "structure":
      return (
        <>
          <p className={text}>
            {done
              ? "The Library's top-level folders are chosen. Rename, add or move them in the Library; every link follows."
              : step.waitsFor
                ? "Once the first crawl has finished, Orbik reads your site and proposes two or three ways to organise the Library. You pick one and confirm."
                : detail.suggestion === "ready"
                  ? "Orbik read your site and proposed ways to organise the Library's top-level folders. Pick one, change it if you like, and confirm. The agent writes nothing until you do."
                  : "Choose the Library's top-level folders — Orbik's default, or a structure it proposes from your site — change them if you like, and confirm. The agent writes nothing until you do."}
          </p>
          {!step.waitsFor && <ActionLink href={libraryHref} primary={primary && !done}>{done ? "Open the Library" : "Choose folders"}</ActionLink>}
        </>
      );
    case "library":
      return (
        <>
          <p className={text}>
            {done
              ? `Orbik wrote the overview and ${plural(detail.files, "file")} around it, and rewrites them when your site changes.`
              : step.state === STEP_STATE.attention
                ? detail.error?.message ?? "The last write did not finish. It is tried again when your site next changes."
                : detail.working === false
                  ? "The Library agent is paused, so nothing is written. Set it to work at the foot of the Library's explorer."
                  : "Orbik does this itself — there is nothing for you to do. It writes the overview first, then the folders around it, from the pages your site links to most."}
          </p>
          <ActionLink href={libraryHref} primary={primary && detail.working === false}>Open the Library</ActionLink>
        </>
      );
    case "ai":
      return (
        <>
          <p className={text}>
            Give Claude, ChatGPT or Cursor read access to this workspace&apos;s knowledge, so it answers from what your site
            actually says.
            {home.steps.find((other) => other.id === "library")?.state !== STEP_STATE.done && " You can connect it now: it sees pages as they arrive."}
          </p>
          <ConnectAiStep workspaceId={id} settingsHref={`/workspaces/${id}/settings/ai`} onChanged={onChanged} />
        </>
      );
    case "brand":
      return (
        <>
          <p className={text}>
            {done
              ? "Orbik derived your design system — colours, type and logo — from your site. Pin any value you know better."
              : step.state === STEP_STATE.attention
                ? detail.error?.message ?? "The last derivation did not finish."
                : "Orbik can render a few of your pages and derive your colours, type and logo, so your own AI can draw on-brand."}
          </p>
          <ActionLink href={`/workspaces/${id}/brand`}>Open Brand</ActionLink>
        </>
      );
    case "team":
      return (
        <>
          <p className={text}>
            {done
              ? `${plural(detail.members, "person", "people")} besides the owner${detail.invites ? `, and ${plural(detail.invites, "invite")} waiting` : ""}.`
              : "Invite people by link from Settings, as an admin, a member or read-only."}
          </p>
          <ActionLink href={`/workspaces/${id}/settings/people`}>{done ? "Manage people" : "Invite people"}</ActionLink>
        </>
      );
    default:
      return null;
  }
}
