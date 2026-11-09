"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeftRight, Check, Clock, Info, Minus, ShieldCheck, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { NeutralLoading } from "@/components/NeutralLoading";
import { OrbikMark } from "@/components/OrbikMark";
import { approveAuthorizationRequest, denyAuthorizationRequest, readAuthorizationRequest } from "@/lib/api/oauth";
import { cn } from "@/lib/utils";
import { can, roleLabel, roleOf } from "@/lib/workspaces/roles";
import { AUTH_LINK, AuthError, AuthPanel } from "./AuthFrame";

/**
 * Asks one person whether an AI app may read their workspaces, and which.
 *
 * This is the only page in Orbik somebody arrives at from outside it — an AI client sends them —
 * and that shapes what it has to say. They did not come here to browse, they came holding a
 * question somebody else asked, so the page states the question, names who is asking, says exactly
 * what "read" means, and offers two answers. No navigation, no sidebar, nothing to wander into.
 *
 * Two decisions. The first is which workspaces: all of theirs, including ones they create or join later,
 * or the ones they tick. Claude.ai and ChatGPT keep one connection per server, so this is where a
 * person with several sites decides how much of Orbik that one connection reads. With one workspace
 * the page asks nothing: that workspace, as it always was.
 *
 * The second is whether the app may also write to their Libraries — a box, off until they tick
 * it, whatever the app asked for: the apps that matter cannot ask on somebody's behalf, and one that
 * can has not thereby been allowed. The client was fixed when the request was validated, before
 * this page existed, so approving sends nothing but these two answers.
 */
export function ConsentForm() {
  const requestId = useSearchParams().get("request");
  const [request, setRequest] = useState(null);
  // "all" or "selected", and the ticked workspaces when it is the second.
  const [mode, setMode] = useState("selected");
  const [selected, setSelected] = useState([]);
  // Whether the app may also write to the Library. Off until the person ticks it.
  const [write, setWrite] = useState(false);
  const [failure, setFailure] = useState(null);
  const [deciding, setDeciding] = useState(false);
  // A link with no request identifier has nothing to load, so it starts settled rather than being
  // settled by an effect: the value is derived from the URL and known on the first render.
  const [loading, setLoading] = useState(Boolean(requestId));

  const error =
    failure ?? (requestId ? null : "This link is missing its authorization request. Start again from your AI client.");

  const report = useCallback((caught) => {
    setFailure(caught?.message ?? "Something went wrong. Try again from your AI client.");
  }, []);

  useEffect(() => {
    if (!requestId) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const described = await readAuthorizationRequest(requestId);
        if (cancelled) return;
        setRequest(described);
        // With several workspaces "all" is offered first and chosen; "Only these" starts with
        // nothing ticked, so a narrower choice is always a deliberate one. With one, that one.
        if (described.workspaces.length > 1) {
          setMode("all");
          setSelected([]);
        } else {
          setMode("selected");
          setSelected(described.workspaces.map((workspace) => workspace.id));
        }
      } catch (failure) {
        if (!cancelled) report(failure);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestId, report]);

  /**
   * Sends the person back to the AI client with the answer.
   *
   * A full page assignment rather than the router, because the destination is the client's own URL
   * — frequently a loopback address an editor is listening on — and Next's router only navigates
   * within this app.
   */
  async function decide(answer) {
    setDeciding(true);
    setFailure(null);
    try {
      const workspaces =
        mode === "all"
          ? { mode: "all" }
          : // In the order they are listed, not the order they were ticked.
            { mode: "selected", ids: request.workspaces.map((one) => one.id).filter((id) => selected.includes(id)) };
      const { redirectTo } =
        answer === "allow"
          ? await approveAuthorizationRequest(requestId, { workspaces, write: writing })
          : await denyAuthorizationRequest(requestId);
      window.location.assign(redirectTo);
    } catch (failure) {
      report(failure);
      setDeciding(false);
    }
  }

  if (loading) return <NeutralLoading inline label="Loading the authorization request" />;

  if (!request) {
    return (
      <AuthPanel
        size="lg"
        eyebrow={
          <span aria-hidden="true" className="flex size-11 items-center justify-center rounded-xl border border-orb-line bg-orb-raised/60 text-orb-muted">
            <Clock className="size-5" />
          </span>
        }
        title="Nothing to approve"
        description="This request is no longer available."
      >
        <div className="space-y-4">
          <AuthError>{error}</AuthError>
          <p className="text-sm text-orb-gray">
            Authorization requests expire after ten minutes. Ask your AI client to connect again.
          </p>
        </div>
      </AuthPanel>
    );
  }

  const hasWorkspaces = request.workspaces.length > 0;
  const several = request.workspaces.length > 1;
  const chosen = mode === "all" || selected.length > 0;
  // Writing needs member or above on every workspace the app will read; the API refuses the
  // approval otherwise, so the box is not offered when a read-only workspace is in the choice.
  const covered = mode === "all" ? request.workspaces : request.workspaces.filter((one) => selected.includes(one.id));
  const readOnlyCovered = covered.filter((one) => !can(roleOf(one), "member"));
  const writeBlocked = readOnlyCovered.length
    ? mode === "all" && several
      ? "You are read-only in at least one of your workspaces, so an app reading all of them can only read. Choose only workspaces where you can edit to allow writing."
      : several
        ? `You are read-only in ${readOnlyCovered.map((one) => one.name).join(", ")}, so the app can only read. Untick ${readOnlyCovered.length === 1 ? "it" : "them"} to allow writing.`
        : "Your role in this workspace is read-only, so the app can only read it."
    : null;
  const writing = write && !writeBlocked;
  // A box that became blocked is cleared, so it does not come back ticked when the choice changes back.
  if (writeBlocked && write) setWrite(false);
  const toggle = (id) =>
    setSelected((current) => (current.includes(id) ? current.filter((one) => one !== id) : [...current, id]));

  return (
    <AuthPanel
      size="lg"
      eyebrow={<ConnectionMark name={request.client.name} />}
      title={<>Let {request.client.name} {writing ? "read and add to" : "read"} your knowledge base?</>}
      description={
        request.client.uri ? (
          <>
            It says it is{" "}
            <a href={request.client.uri} rel="noreferrer noopener" target="_blank" className={AUTH_LINK}>
              {new URL(request.client.uri).host}
            </a>
            . Approve it only if you started this from that app.
          </>
        ) : (
          <>Approve it only if you just asked that app to connect to Orbik.</>
        )
      }
    >
      <div className="space-y-6">
        {error && <AuthError>{error}</AuthError>}

        <ClientProvenance verified={request.client.verified} clientId={request.client.id} />

        <section aria-labelledby="consent-can" className="space-y-2.5">
          <h2 id="consent-can" className="text-sm font-semibold text-orb-white">What it will be able to do</h2>
          <ul className="space-y-2 text-sm text-orb-gray">
            <Ability icon={Check} tone="lime">
              Read the Library, your crawled pages, and llms.txt for the{" "}
              {several ? "workspaces you choose" : "workspace you pick"}.
            </Ability>
            {writing && (
              <Ability icon={Check} tone="lime">
                Write files and folders in {several ? "their Libraries" : "its Library"}, as you, inside your
                top-level folders — never in Sources or anything you locked.
              </Ability>
            )}
            <Ability icon={Minus}>{describeLimits({ mode, selected: selected.length, total: request.workspaces.length, write: writing })}</Ability>
            <Ability icon={Info}>The AI doing the reading is its own; Orbik only serves what it reads.</Ability>
          </ul>
        </section>

        {hasWorkspaces && several ? (
          <fieldset className="space-y-2.5" disabled={deciding}>
            <legend className="mb-2.5 text-sm font-semibold text-orb-white">Which workspaces may it read?</legend>
            <div role="radiogroup" className="grid gap-2">
              <ChoicePill name="workspace-scope" value="all" selected={mode === "all"} onSelect={() => setMode("all")}>
                <span className="min-w-0 flex-1">All workspaces I can read, including ones I create or join later</span>
                <span className="shrink-0 text-xs text-orb-muted">{request.workspaces.length} today</span>
              </ChoicePill>
              <ChoicePill name="workspace-scope" value="selected" selected={mode === "selected"} onSelect={() => setMode("selected")}>
                <span className="min-w-0 flex-1">Only these</span>
              </ChoicePill>
            </div>
            {mode === "selected" && (
              <ul className="divide-y divide-orb-line/70 overflow-hidden rounded-lg border border-orb-line bg-orb-space/50" aria-label="Workspaces it may read">
                {request.workspaces.map((workspace) => (
                  <li key={workspace.id}>
                    <label className="flex cursor-pointer flex-wrap items-center gap-x-2.5 gap-y-1 px-3 py-2.5 text-sm transition-colors hover:bg-orb-raised/70 sm:px-4">
                      <input
                        type="checkbox"
                        className="size-4 shrink-0 accent-orb-lime"
                        value={workspace.id}
                        checked={selected.includes(workspace.id)}
                        onChange={() => toggle(workspace.id)}
                      />
                      <span className="min-w-[8rem] flex-1 truncate font-medium text-orb-white">{workspace.name}</span>
                      {workspace.websiteUrl && (
                        <span className="shrink-0 text-xs text-orb-muted">{hostOf(workspace.websiteUrl)}</span>
                      )}
                      {workspace.role && workspace.role !== "owner" && (
                        <Pill tone={workspace.role === "admin" ? "cyan" : workspace.role === "read-only" ? "muted" : "neutral"}>{roleLabel(workspace.role)}</Pill>
                      )}
                    </label>
                  </li>
                ))}
                {!selected.length && <li className="px-3 py-2 text-xs text-orb-orange sm:px-4">Tick at least one workspace.</li>}
              </ul>
            )}
          </fieldset>
        ) : hasWorkspaces ? (
          <fieldset className="space-y-2.5" disabled={deciding}>
            <legend className="mb-2.5 text-sm font-semibold text-orb-white">Which workspace may it read?</legend>
            <div role="radiogroup" className="grid gap-2">
              {request.workspaces.map((workspace) => (
                <ChoicePill key={workspace.id} name="workspace" value={workspace.id} selected onSelect={() => {}}>
                  <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                  {workspace.websiteUrl && (
                    <span className="shrink-0 text-xs text-orb-muted">{hostOf(workspace.websiteUrl)}</span>
                  )}
                </ChoicePill>
              ))}
            </div>
          </fieldset>
        ) : (
          <div role="status" className="rounded-lg border border-dashed border-orb-line px-4 py-4 text-sm text-orb-gray">
            You have no workspaces yet, so there is nothing for this app to read.{" "}
            <Link href="/workspaces/new" className={AUTH_LINK}>
              Create one
            </Link>{" "}
            and start again from your AI client.
          </div>
        )}

        {hasWorkspaces && (
          <label
            className={cn(
              "flex items-start gap-3 rounded-lg border px-3.5 py-3 text-sm transition-colors",
              writing ? "border-orb-lime/50 bg-orb-lime/5" : "border-dashed border-orb-line",
              writeBlocked ? "opacity-70" : "cursor-pointer hover:border-orb-muted/60",
            )}
          >
            <input
              type="checkbox"
              name="allow-write"
              className="mt-0.5 size-4 shrink-0 accent-orb-lime"
              checked={writing}
              disabled={deciding || Boolean(writeBlocked)}
              onChange={(event) => setWrite(event.target.checked)}
            />
            <span className="space-y-1">
              <span className="block font-medium text-orb-white">Allow this app to write to the Library</span>
              <span className="block text-xs leading-relaxed text-orb-gray">
                {request.asksToWrite ? "It asked to. " : ""}It could then save what you ask it to — a file or a
                folder — as you. What it adds is kept from Orbik&apos;s agents like your own edits, and every
                file keeps its earlier versions, so a change can be undone from the Library.
              </span>
              {writeBlocked && <span className="block text-xs text-orb-coral" data-testid="consent-write-blocked">{writeBlocked}</span>}
            </span>
          </label>
        )}

        <div className="space-y-3 border-t border-orb-line/70 pt-5">
          <div className="flex flex-wrap gap-2">
            <Button type="button" className="h-10 min-w-[8rem] flex-1" onClick={() => decide("allow")} disabled={deciding || !hasWorkspaces || !chosen}>
              {deciding ? "Working…" : "Allow"}
            </Button>
            <Button type="button" variant="outline" className="h-10 min-w-[8rem] flex-1" onClick={() => decide("deny")} disabled={deciding}>
              Cancel
            </Button>
          </div>
          <p className="text-center text-xs text-orb-muted">
            You can disconnect it at any time from the AI settings of any workspace it reads, which
            stops it everywhere.
          </p>
        </div>
      </div>
    </AuthPanel>
  );
}

/**
 * Who is asking, drawn: the app's initial and Orbik's mark with a link between them. Decoration,
 * because the title says the same in words.
 */
function ConnectionMark({ name }) {
  const initial = String(name ?? "").match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? "·";
  return (
    <span aria-hidden="true" className="flex items-center gap-2.5">
      <span className="flex size-11 items-center justify-center rounded-xl border border-orb-line bg-orb-space/70 font-display text-lg font-bold text-orb-white">
        {initial}
      </span>
      <ArrowLeftRight className="size-4 text-orb-muted" />
      <span className="flex size-11 items-center justify-center rounded-xl border border-orb-lime/40 bg-orb-lime/10 text-orb-lime">
        <OrbikMark className="h-5 w-auto" />
      </span>
    </span>
  );
}

/** One line of what the app can or cannot do, with a mark for which. */
function Ability({ icon: Icon, tone, children }) {
  return (
    <li className="flex gap-2.5">
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", tone === "lime" ? "text-orb-lime" : "text-orb-muted")} />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/**
 * One option in a radio group, drawn as a bordered choice with its own dot: the native input kept
 * for keyboards and screen readers, the label drawn as the control.
 */
function ChoicePill({ name, value, selected, onSelect, children }) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-lg border px-3.5 py-2.5 text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring/60",
        selected ? "border-orb-lime/50 bg-orb-lime/5 font-medium text-orb-white" : "border-orb-line text-orb-gray hover:border-orb-muted/60 hover:text-orb-white",
      )}
    >
      <input type="radio" name={name} value={value} checked={selected} onChange={onSelect} className="sr-only" />
      <span aria-hidden="true" className={cn("flex size-4 shrink-0 items-center justify-center rounded-full border", selected ? "border-orb-lime" : "border-orb-muted")}>
        {selected && <span className="size-2 rounded-full bg-orb-lime" />}
      </span>
      {children}
    </label>
  );
}

/**
 * Says what the app still cannot do, for the choice as it stands.
 *
 * Written for the choice rather than once, because "it cannot see your other workspaces" is true of
 * a selection and false of "all" — which instead reaches workspaces that do not exist yet, the one
 * thing about it a person should not discover later — and "it cannot write" is true only until the
 * box is ticked.
 */
function describeLimits({ mode, selected, total, write }) {
  const cannot = write ? "It cannot move or delete anything, or start an agent" : "It cannot write or start an agent";
  if (mode === "all") {
    return `Nothing else. ${cannot}. It will also read workspaces you create or join later.`;
  }
  if (total > 1 && selected === total) {
    return write
      ? "Nothing else. It cannot move or delete anything, start an agent, or see workspaces you create or join later."
      : "Nothing else. It cannot write, start an agent, or see workspaces you create or join later.";
  }
  return write
    ? "Nothing else. It cannot move or delete anything, start an agent, or see your other workspaces."
    : "Nothing else. It cannot write, start an agent, or see your other workspaces.";
}

/**
 * Says how much is actually known about who is asking.
 *
 * The one thing a person cannot check for themselves, and the difference matters: a client that
 * publishes its metadata at an address it controls has proved it owns that address, while a client
 * that registered itself has proved only that it could call an endpoint anyone can call. Saying so
 * plainly is better than a reassuring tick that means neither.
 */
function ClientProvenance({ verified, clientId }) {
  const Icon = verified ? ShieldCheck : TriangleAlert;
  return (
    <div
      className={cn(
        "flex gap-2.5 rounded-lg border px-3.5 py-3",
        verified ? "border-orb-line bg-orb-space/50" : "border-orb-orange/40 bg-orb-orange/10",
      )}
    >
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", verified ? "text-orb-lime" : "text-orb-orange")} />
      <p className="min-w-0 text-xs leading-relaxed text-orb-gray">
        {verified ? (
          <>
            This app is identified by{" "}
            <span className="font-medium text-orb-white [overflow-wrap:anywhere]">{clientId}</span>, which Orbik read
            directly. Whoever controls that address controls this app.
          </>
        ) : (
          <>
            <span className="font-medium text-orb-white">This app registered itself and its name is not verified.</span> Approve it only if you just
            started this from the app you are expecting.
          </>
        )}
      </p>
    </div>
  );
}

/** The host of a workspace's website, for telling two similarly named workspaces apart. */
function hostOf(websiteUrl) {
  try {
    return new URL(websiteUrl).host;
  } catch {
    return null;
  }
}
