"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, CircleAlert, Lock, LoaderCircle } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { ConnectAiStep } from "./ConnectAiStep";
import { STEP_STATE, STEP_TITLES, WAITS_FOR, ago, crawlBudgetWords, doneLine, plural, whoCanDo } from "@/lib/home/home";
import { setAgentWorking } from "@/lib/api/agentSetup";
import { aiUnavailableText, isAiUnavailableError, useAiAvailability } from "@/lib/ask/ai";
import { libraryWait } from "@/lib/library/agentWait";
import { cn } from "@/lib/utils";

/** The agent that writes the Library, whose switch the "Library written" step can turn on. */
const KNOWLEDGE_AGENT_SLUG = "business-knowledge-base";

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
 * @param {(configured: boolean) => Promise<void>} props.onStartCrawl starts the first crawl from the
 *   workspace's website and goes to the Crawler; throws the API's refusal
 * @param {() => void} props.onChanged re-reads Home
 */
export function SetupChecklist({ home, myEmail, onPreferences, onRetryCrawl, onStartCrawl, onChanged }) {
  const ai = useAiAvailability();
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
      <section id="home-setup" aria-label="Setup" className="scroll-mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-orb-line bg-orb-raised/40 px-4 py-2.5">
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
    <section id="home-setup" aria-labelledby="home-setup-title" className="scroll-mt-4 rounded-xl border border-orb-line bg-orb-raised/40">
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
            ai={ai}
            onRetryCrawl={onRetryCrawl}
            onStartCrawl={onStartCrawl}
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
                ai={ai}
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
function StepRow({ step, number, last, open, primary = false, onToggle, home, myEmail, ai, busy, onSkip, onRetryCrawl, onStartCrawl, onChanged }) {
  const title = STEP_TITLES[step.id] ?? step.id;
  const status = statusLine(step, myEmail, ai, home);
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
            <StepBody step={step} home={home} ai={ai} primary={primary} onRetryCrawl={onRetryCrawl} onStartCrawl={onStartCrawl} onChanged={onChanged} />
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
function statusLine(step, myEmail, ai, home) {
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
      case "library":
        return detail.filesWritten ? `Writing — ${plural(detail.filesWritten, "file")} so far` : detail.copying ? "Copying your pages into Sources…" : "Writing…";
      case "ai": return "Connected, waiting for the first call";
      case "brand": return "Deriving…";
      default: return "In progress…";
    }
  }
  if (step.state === STEP_STATE.attention) return detail.error?.message ? "Needs attention" : "The last attempt failed";
  if (step.id === "website" && crawlBudgetWords(detail.budget).blocked) return "No crawl budget";
  // What the Library is waiting for, as the Library page itself says it.
  if (step.id === "library") {
    const wait = libraryWaitFor(step, home, ai);
    if (wait) return capitalised(wait.short);
  }
  if (step.waitsFor) return `Waits for ${WAITS_FOR[step.waitsFor] ?? "the step before"}`;
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
function StepBody({ step, home, ai, primary, onRetryCrawl, onStartCrawl, onChanged }) {
  const id = home.workspace.id;
  const detail = step.detail ?? {};
  const done = step.state === STEP_STATE.done;
  const text = "max-w-[62ch] text-sm leading-relaxed text-orb-gray";
  const libraryHref = `/workspaces/${id}/library`;

  switch (step.id) {
    case "website":
      return <WebsiteStep step={step} home={home} primary={primary} onRetryCrawl={onRetryCrawl} onStartCrawl={onStartCrawl} />;
    case "structure": {
      // Changing the folders in words is a model call, so it is offered only while AI is
      // available; the standard folders and editing them by hand are always there.
      const asks = ai.reasoning;
      return (
        <>
          <p className={text}>
            {done
              ? "The Library's top-level folders are chosen. Rename, add or move them in the Library; every link follows."
              : step.waitsFor
                ? "Once the first crawl has finished, you choose the Library's top-level folders: Orbik's standard ones, changed as you like. Then confirm."
                : asks
                  ? "Choose the Library's top-level folders: start from Orbik's standard ones, rename, reorder or remove them, or ask for changes in your own words, then confirm. The agent writes nothing until you do."
                  : "Choose the Library's top-level folders: start from Orbik's standard ones, rename, reorder or remove them, then confirm. The agent writes nothing until you do."}
          </p>
          {!step.waitsFor && <ActionLink href={libraryHref} primary={primary && !done}>{done ? "Open the Library" : "Choose folders"}</ActionLink>}
        </>
      );
    }
    case "library":
      return <LibraryStep step={step} home={home} ai={ai} primary={primary} onChanged={onChanged} />;
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
                ? isAiUnavailableError(detail.error)
                  ? aiUnavailableText("your design system cannot be derived", { isAdmin: ai.isAdmin })
                  : detail.error?.message ?? "The last derivation did not finish."
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

/**
 * Connect your website. Before the first crawl its button starts that crawl from the workspace's
 * website — the address the person gave when they created it — and opens the Crawler to watch it;
 * the Crawler's set-up page is one link away for a different start address or sitemaps. A refusal
 * (no budget left, say) is shown here, in the API's words.
 */
function WebsiteStep({ step, home, primary, onRetryCrawl, onStartCrawl }) {
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState(null);
  const id = home.workspace.id;
  const detail = step.detail ?? {};
  const text = "max-w-[62ch] text-sm leading-relaxed text-orb-gray";
  const crawlerHref = `/workspaces/${id}/agents/crawler`;
  const host = detail.host ?? "your site";
  const { blocked, cost } = crawlBudgetWords(detail.budget);

  async function start() {
    setStarting(true);
    setFailure(null);
    try {
      // On success this goes to the Crawler, so the button says "Starting…" until the page changes.
      await onStartCrawl(Boolean(detail.configured));
    } catch (error) {
      setFailure(error?.message ?? "The crawl could not be started. Try again.");
      setStarting(false);
    }
  }

  if (step.state === STEP_STATE.attention) {
    return (
      <>
        <p className={text}>{detail.error?.message ?? "The last crawl did not finish."}</p>
        {blocked && <p className={text}>{blocked}</p>}
        <div className="flex flex-wrap gap-2">
          {step.permitted && <Button type="button" size="sm" disabled={Boolean(blocked)} onClick={onRetryCrawl}>Crawl again</Button>}
          <ActionLink href={crawlerHref}>Open the Crawler</ActionLink>
        </div>
      </>
    );
  }
  if (step.state === STEP_STATE.done) {
    return (
      <>
        <p className={text}>{`Orbik keeps ${host} up to date on a schedule; the Crawler page shows what it found.`}</p>
        <ActionLink href={crawlerHref}>Open the Crawler</ActionLink>
      </>
    );
  }
  if (step.state !== STEP_STATE.notStarted || !step.permitted) {
    return (
      <>
        <p className={text}>{`Orbik reads ${host} page by page, obeying robots.txt.`}</p>
        <ActionLink href={crawlerHref}>{step.state === STEP_STATE.inProgress ? "Watch the crawl" : "Open the Crawler"}</ActionLink>
      </>
    );
  }
  return (
    <>
      <p className={text}>
        {blocked
          ?? `Orbik reads ${host} page by page, starting from ${detail.seedUrl ?? "its home page"} and obeying robots.txt.${cost ? ` Each page fetched costs one page of crawl budget — ${cost}.` : ""}`}
      </p>
      {failure && <p role="alert" className="max-w-[62ch] text-sm text-orb-coral">{failure}</p>}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button
          type="button"
          size="sm"
          variant={primary ? "default" : "outline"}
          disabled={starting || Boolean(blocked) || !detail.seedUrl}
          onClick={start}
        >
          {starting ? "Starting…" : "Start first crawl"}
        </Button>
        <Link href={crawlerHref} className="text-sm text-orb-gray underline-offset-4 hover:text-orb-white hover:underline">
          Choose the start address or add sitemaps first
        </Link>
      </div>
    </>
  );
}

/**
 * Library written: Orbik does it, so the step says what it is waiting for — the agent being set
 * to work (with the switch, for whoever may turn it on), AI the install does not have, the folders
 * being chosen — or that it is writing, or done. Read from the Library's own setup state on the
 * Home read and from what the install says about AI; nothing here decides it.
 */
function LibraryStep({ step, home, ai, primary, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const id = home.workspace.id;
  const detail = step.detail ?? {};
  const text = "max-w-[62ch] text-sm leading-relaxed text-orb-gray";
  const libraryHref = `/workspaces/${id}/library`;
  const writes = "the overview first, then the folders around it, from the pages your site links to most";

  async function setToWork() {
    setBusy(true);
    setFailure(null);
    try {
      await setAgentWorking(id, KNOWLEDGE_AGENT_SLUG, true);
      onChanged();
    } catch (error) {
      setFailure(error?.message ?? "The Library agent could not be set to work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  // Before the first write, what it waits on is the Library page's own account (`libraryWait`),
  // from the same facts — the scheduler's last answer among them — so the two pages agree.
  const wait = step.state === STEP_STATE.done || step.state === STEP_STATE.inProgress ? null : libraryWaitFor(step, home, ai);
  let sentence;
  if (step.state === STEP_STATE.done) {
    sentence = `Orbik wrote the overview and ${plural(detail.files, "file")} around it, and rewrites them when your site changes.`;
  } else if (step.state === STEP_STATE.inProgress) {
    sentence = `Orbik is writing it: ${writes}.`;
  } else if (wait?.kind === "failed" && isAiUnavailableError(detail.error)) {
    sentence = aiUnavailableText("the Library cannot be written", { isAdmin: ai.isAdmin, reason: detail.error?.message });
  } else if (wait) {
    // Where the detail already says the knowledge base cannot be written, the title would say it twice.
    sentence = wait.kind === "ai" || wait.kind === "plan" ? wait.detail : `${wait.title}. ${wait.detail}`;
  } else {
    sentence = `Orbik writes it on its own: ${writes}.`;
  }
  const paused = wait?.action === "work";

  return (
    <>
      <p className={text}>{sentence}</p>
      {failure && <p role="alert" className="max-w-[62ch] text-sm text-orb-coral">{failure}</p>}
      <div className="flex flex-wrap gap-2">
        {paused && step.permitted && step.state !== STEP_STATE.done && (
          <Button type="button" size="sm" variant={primary ? "default" : "outline"} disabled={busy} onClick={setToWork}>
            {busy ? "Setting to work…" : "Set the Library agent to work"}
          </Button>
        )}
        <ActionLink href={libraryHref}>Open the Library</ActionLink>
      </div>
    </>
  );
}

/**
 * What the Library's agent waits on before its first write — `libraryWait`, the Library page's
 * one account of it — from what the Home read carries: whether the first crawl is in, whether the
 * folders are chosen, the agent's switch, the scheduler's last answer (`writer`), the newest run,
 * and whether the install has AI.
 */
function libraryWaitFor(step, home, ai) {
  const detail = step.detail ?? {};
  const done = (id) => home.steps.find((other) => other.id === id)?.state === STEP_STATE.done;
  return libraryWait({
    state: {
      readiness: { markdownPages: done("website") ? 1 : 0 },
      structure: { needsChoice: !done("structure"), reason: null },
      writer: detail.writer ?? { working: detail.working !== false, check: null, everyMs: null },
      latestRun: detail.latestRun ?? null,
    },
    work: { inFlight: step.state === STEP_STATE.inProgress, working: detail.working !== false, run: detail.latestRun ?? null },
    canEdit: Boolean(step.permitted),
    isAdmin: ai.isAdmin,
    edition: ai.reasoning ? null : { ai: { reasoning: false } },
  });
}

/** A phrase with its first letter in capitals: "paused" → "Paused". */
function capitalised(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}
