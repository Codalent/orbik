import { aiUnavailableText, isAiUnavailable } from "@/lib/agents/aiAvailability";
import { formatDate } from "@/lib/format";

/**
 * What the Knowledge base agent is waiting on before it writes, said the same way everywhere the
 * Library says it: the overview that has not been written, the agent's line in the explorer, the
 * status line along the foot, What changed, and the folder choice.
 *
 * A Library that never fills with no reason given is the worst thing this page can show, and the
 * reasons are known: the site has not been crawled, its folders have not been chosen, the agent is
 * paused, no AI is available to write with, the workspace's plan does not include it, or the crawl
 * or the copy into Sources is still going. Most of them the page can see for itself; the ones only
 * the agents process knows — whether a reasoning provider is configured there, what the plan said
 * — the Library scheduler records on every pass, and `GET /library` carries as `writer.check`.
 *
 * Who is reading changes the words, not the facts. An install's admin is told the setting to
 * change; everyone else is told that AI is not available here, and what that means for them, with
 * no environment variable or error code in sight.
 *
 * @param {object} options
 * @param {object|null} options.state the `GET /library` answer
 * @param {{inFlight: boolean, working: boolean, run: object|null}} options.work from `useAgentWork`
 * @param {boolean} options.canEdit whether the reader may change the Library (member and up)
 * @param {boolean} options.isAdmin whether the reader administers this install
 * @param {object|null} [options.edition] `GET /v1/edition`; `ai.reasoning === false` says no
 *   reasoning provider is configured, anything else is taken as available
 * @param {number} [options.now] the time to judge a stale check against
 * @returns {null|{
 *   kind: "writing"|"crawl"|"structure"|"paused"|"ai"|"plan"|"failed"|"busy"|"stalled"|"starting",
 *   short: string, title: string, detail: string,
 *   action: null|"crawl"|"structure"|"work", tone: "lime"|"orange"|"coral"|"muted"
 * }} null when nothing is being waited on: the Library has been written and the agent is idle
 */
export function libraryWait({ state, work, canEdit, isAdmin, edition = null, now = Date.now() }) {
  if (!state) return null;
  if (work?.inFlight) {
    return {
      kind: "writing",
      short: "writing now",
      title: "The agent is writing the Library now",
      detail: "It writes the overview first, then the folders around it. Each file appears as it is written.",
      action: null,
      tone: "lime",
    };
  }

  const check = state.writer?.check ?? null;
  const everyMs = state.writer?.everyMs ?? null;
  // The switch as the agent's own setup says it once that is read, and as the Library's read says
  // it before, so the page does not open on "paused" for the moment between the two.
  const working = work?.setup ? Boolean(work.working) : Boolean(state.writer?.working ?? work?.working);
  // Any run at all, from either read: until the agent's run list arrives, the Library's says.
  const run = work?.run ?? state.latestRun ?? null;

  if (!((state.readiness?.markdownPages ?? 0) > 0)) {
    return {
      kind: "crawl",
      short: "waiting for a crawl",
      title: "Your site has not been crawled yet",
      detail: canEdit
        ? "The knowledge base is written from your site's pages. Crawl the site, and every page is copied into Sources when the crawl finishes."
        : "The knowledge base is written from the site's pages, and the site has not been crawled yet.",
      action: canEdit ? "crawl" : null,
      tone: "muted",
    };
  }

  if (state.structure?.needsChoice) {
    const rebuild = state.structure.reason === "rebuild";
    return {
      kind: "structure",
      short: "waiting for its folders",
      title: rebuild ? "Choose the Library's folders again" : "Choose how your Library is organised",
      detail: canEdit
        ? "The agent files everything it writes into top-level folders you choose, and writes nothing until they are chosen."
        : "The agent files everything it writes into top-level folders a member of this workspace chooses, and writes nothing until they are chosen.",
      action: canEdit ? "structure" : null,
      tone: "orange",
    };
  }

  if (!working) {
    return {
      kind: "paused",
      short: "paused",
      title: "The agent is paused",
      detail: canEdit
        ? "Nothing is written until the Knowledge base agent is set to work. Your site is still crawled and copied into Sources meanwhile."
        : "Nothing is written until a member of this workspace sets the Knowledge base agent to work.",
      action: canEdit ? "work" : null,
      tone: "muted",
    };
  }

  // A run that failed over the plan says so as the scheduler would have, so the same reason reads
  // the same however it was met.
  const failedFor = run?.status === "failed" ? run.error?.code ?? null : null;

  if (aiAvailability({ state, edition, work }) === "unavailable") {
    return {
      kind: "ai",
      short: "AI not available",
      title: "The knowledge base cannot be written yet",
      detail: aiUnavailableSentence({
        isAdmin,
        consequence: "the knowledge base cannot be written",
        after: isAdmin ? "The run then starts on its own." : "Your pages are still copied into Sources, and it is written as soon as AI is available.",
      }),
      action: null,
      tone: "orange",
    };
  }

  if (check?.code === "PLAN_LIMIT_REACHED" || failedFor === "PLAN_LIMIT_REACHED") {
    return {
      kind: "plan",
      short: "not included in the plan",
      title: "The knowledge base cannot be written yet",
      detail: check?.limit === "agents"
        ? "This workspace's plan does not include the Knowledge base agent, so the knowledge base is not written. Your pages are still copied into Sources."
        : check?.limit === "aiCalls"
          ? "This workspace's plan does not include AI, so the knowledge base is not written. Your pages are still copied into Sources."
          : "This workspace's plan has no AI left for this, so the knowledge base is not being written. Your pages are still copied into Sources and searchable.",
      action: null,
      tone: "orange",
    };
  }

  if (run?.status === "failed") {
    return {
      kind: "failed",
      short: "last run failed",
      title: "The last run failed",
      detail: `${run.error?.message ? `${run.error.message.replace(/\.?$/, ".")} ` : ""}It is tried again when a page the knowledge base is written from changes, or when the agent is paused and set to work again.`,
      action: null,
      tone: "coral",
    };
  }

  const coverage = state.coverage ?? {};
  const outstanding = (coverage.pending ?? 0) + (coverage.failed ?? 0);
  if (check?.code === "CRAWL_IN_FLIGHT") {
    return {
      kind: "busy",
      short: "waiting for the crawl",
      title: "Waiting for the crawl to finish",
      detail: "The agent writes once the crawl has finished and its pages are copied into Sources, so it reads the site as it is now.",
      action: null,
      tone: "muted",
    };
  }
  if (["MIRROR_IN_FLIGHT", "NOTHING_CHOSEN", "PAGE_REQUESTED"].includes(check?.code) || outstanding > 0) {
    return {
      kind: "busy",
      short: "waiting for the pages",
      title: "Your pages are being copied into Sources",
      detail: outstanding > 0
        ? `${outstanding.toLocaleString()} ${outstanding === 1 ? "page is" : "pages are"} still to be copied. The agent starts writing once they are.`
        : "The agent starts writing once the copy has finished.",
      action: null,
      tone: "muted",
    };
  }

  // Nothing stands in the way. A loop that stopped looking would leave this waiting for good, so
  // a check much older than the loop's own interval is said to be one.
  const interval = everyMs ?? 60_000;
  const checkedAt = check?.at ? new Date(check.at).getTime() : null;
  if (checkedAt && now - checkedAt > Math.max(interval * 5, 10 * 60_000) && !run) {
    return {
      kind: "stalled",
      short: "not checked lately",
      title: "The agent has not checked for work lately",
      detail: isAdmin
        ? `The Library scheduler last looked at this workspace ${formatDate(check.at)}. Check that the agents scheduler process is running; the run starts on its next pass.`
        : `The agent last checked for work ${formatDate(check.at)}. It starts writing as soon as it checks again.`,
      action: null,
      tone: "orange",
    };
  }

  if (!run) {
    return {
      kind: "starting",
      short: `starts within ${aboutInterval(interval)}`,
      title: "The agent is about to start writing",
      detail: `It checks for work ${everyInterval(interval)}, so its first run starts within ${aboutInterval(interval)}, and this page follows it as it writes. A first build takes a few minutes.`,
      action: null,
      tone: "lime",
    };
  }

  return null;
}

/**
 * Whether a reasoning provider is there for the agent to write with: "unavailable", "available",
 * or "unknown" when nothing has said yet.
 *
 * The Library scheduler is the one that knows — it reads the agents' environment — and every
 * reason it gives after `NOT_WORKING` is one it gives only with a provider configured. The edition's
 * `ai.reasoning`, where the API reports it, says the same for the whole install; a run that failed
 * for want of one says it too.
 */
export function aiAvailability({ state, edition = null, work = null }) {
  const code = state?.writer?.check?.code ?? null;
  const run = work?.run ?? state?.latestRun ?? null;
  const failedForAi = run?.status === "failed" && isAiUnavailable(run.error);
  if (code === "PROVIDER_NOT_CONFIGURED" || failedForAi || edition?.ai?.reasoning === false) return "unavailable";
  if (edition?.ai?.reasoning === true || (code && code !== "NOT_WORKING") || run?.status === "succeeded") return "available";
  return "unknown";
}

/**
 * The sentence for "there is no AI to do this with", worded for who is reading: the words every
 * page uses (`aiUnavailableText` in `lib/agents/aiAvailability.js`), with a sentence after.
 *
 * An install's admin is told what is missing and the setting that supplies it; everyone else that
 * AI is not available here and what that means for them — never a variable name or an error code,
 * which only an admin can act on.
 *
 * @param {object} options
 * @param {boolean} options.isAdmin
 * @param {string} options.consequence what cannot happen, as the end of "…, so <consequence>"
 * @param {string} [options.after] a sentence to follow
 */
export function aiUnavailableSentence({ isAdmin, consequence, after = "" }) {
  const sentence = aiUnavailableText({ isAdmin, consequence, reason: isAdmin ? "No AI provider is configured for the agents worker" : null });
  return after ? `${sentence} ${after}` : sentence;
}

/** An interval as a person would say it after "within": "a minute", "5 minutes". */
export function aboutInterval(ms) {
  const minutes = Math.round(ms / 60_000);
  return minutes <= 1 ? "a minute" : `${minutes} minutes`;
}

/** How often, as a person would say it: "every minute", "every 5 minutes". */
function everyInterval(ms) {
  const minutes = Math.round(ms / 60_000);
  return minutes <= 1 ? "every minute" : `every ${minutes} minutes`;
}
