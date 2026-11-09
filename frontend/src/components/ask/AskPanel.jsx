"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import useSWR from "swr";
import {
  ArrowUp,
  FileUp,
  History,
  Maximize2,
  MessageSquarePlus,
  MessagesSquare,
  Minimize2,
  Paperclip,
  Trash2,
  X,
} from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Answer } from "./Answer";
import { FileChip } from "./FileChip";
import { Button } from "@/components/ui/button";
import { IndexStatus } from "./IndexStatus";
import * as api from "@/lib/api/conversations";
import { uploadBrandFile } from "@/lib/api/brand";
import { carriesFiles, useFileDrag } from "@/lib/brand/useFileDrag";
import { useRevalidateWorkspace } from "@/lib/api/cache";
import { useRunEvents } from "@/lib/agents/useRunEvents";
import { ASK_SHORTCUT, useAskPanel } from "@/lib/ask/askPanel";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";
import { useCan } from "@/lib/workspaces/roles";

/** How often a message in flight is polled for progress. */
const POLL_INTERVAL_MS = 1500;

/** Longest message accepted, as the API bounds it. */
const MAX_QUESTION = 1000;

/** A Library path, in the grammar the API accepts. */
const LIBRARY_PATH = /^(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

/** The routes that show the Library, where `?path=` names what is on screen. */
const LIBRARY_ROUTE = /^\/workspaces\/[^/]+\/(?:library|agents\/business-knowledge-base)\/?$/;

/** The routes of the Brand page, where the panel takes files and the brand chat answers. */
const BRAND_ROUTE = /^\/workspaces\/[^/]+\/brand\/?$/;

/** Files one message may carry, as the API bounds it. */
const MAX_FILES = 10;

/** What a message with files and no words says, in the number there are. */
function filesOnly(count) {
  return count === 1 ? "Add this to the brand." : "Add these to the brand.";
}

/** Ways in on the Brand page: one of each thing the brand chat does. */
const BRAND_STARTERS = Object.freeze([
  { label: "Replace the logo with a sharper file", text: "Here is our logo as a sharper file: ", attach: true },
  { label: "Read our brand guidelines", text: "Here are our brand guidelines. ", attach: true },
  { label: "Change a colour or a font", text: "Our primary colour is " },
]);

/** Statuses a turn can be left in while its run is still going. */
const IN_FLIGHT = Object.freeze(["queued", "running"]);

/** Where the open conversation of a workspace is remembered, so the panel reopens on it. */
function threadKey(workspaceId) {
  return `orbik.ask.thread.${workspaceId}`;
}

function rememberedThread(workspaceId) {
  try {
    return window.localStorage.getItem(threadKey(workspaceId));
  } catch {
    return null;
  }
}

function rememberThread(workspaceId, conversationId) {
  try {
    if (conversationId) window.localStorage.setItem(threadKey(workspaceId), conversationId);
    else window.localStorage.removeItem(threadKey(workspaceId));
  } catch {
    // The panel still works; it just will not reopen on this thread after a reload.
  }
}

/** Ways in for a person who has not asked anything yet: one of each thing the panel does. */
const STARTERS = Object.freeze([
  { label: "What do we sell, and to whom?", text: "What do we sell, and to whom?" },
  { label: "Save a note to the Library", text: "Save this to the Library: ", writes: true },
  { label: "Tidy up the Library", text: "Look at how the Library is arranged and suggest a tidier structure.", writes: true },
]);

/**
 * Ask: a chat that opens from the side of every workspace page.
 *
 * It answers from the workspace's index, saves what it is told to the Library, and rearranges the
 * Library when asked — every message one agent run, its Library changes recorded as the person's
 * "via Ask". The panel stays open across pages, so a person can open what an answer cites and
 * carry on the same conversation from there; it knows which page and which Library file they are
 * on, and sends that with each message, so "save this here" and "move this file" mean something.
 *
 * Three things are always on screen, for the reason the old Ask page had them: what the index
 * holds, what each answer is built on, and what each action actually changed — the last read from
 * the run's own record of the calls it completed, never from the model's account of itself.
 *
 * @param {object} props
 * @param {string} props.workspaceId
 * @param {string|null} [props.pageName] the open page's name, as the rail and the sidebar call it
 */
export function AskPanel({ workspaceId, pageName = null }) {
  const panel = useAskPanel();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const revalidateWorkspace = useRevalidateWorkspace(workspaceId);
  // A read-only person's Ask answers but cannot save or rearrange (the API runs the read-only
  // variant for them), so the panel does not offer to.
  const canWrite = useCan("member", workspaceId);

  const [conversation, setConversation] = useState(null);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(null);
  const [steps, setSteps] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  // Whether to send where the person is with the next message. On by default; the chip's × turns
  // it off for a page, and moving to another page turns it back on.
  const [withContext, setWithContext] = useState(true);
  const box = useRef(null);
  const scroller = useRef(null);
  const picker = useRef(null);
  // Files attached to the next message: uploaded already, or on their way. Each chip is one.
  const [files, setFiles] = useState([]);
  const onBrand = BRAND_ROUTE.test(pathname ?? "");
  const takesFiles = onBrand && canWrite;
  const dragging = useFileDrag(Boolean(panel?.open) && takesFiles);

  const threadsRead = useSWR(panel?.open ? api.conversationsPath(workspaceId) : null);
  const indexRead = useSWR(panel?.open ? api.indexStatusPath(workspaceId) : null);
  const threads = threadsRead.data?.items ?? [];
  const index = indexRead.data?.index ?? null;
  const mutateThreads = threadsRead.mutate;

  // Where the person is, as it will be sent: the page's name, its address, and on the Library the
  // file or folder on screen. The Library keeps `?path=` current as files are opened.
  const requestedPath = searchParams.get("path");
  const libraryPath = LIBRARY_ROUTE.test(pathname ?? "") && requestedPath && LIBRARY_PATH.test(requestedPath)
    ? requestedPath
    : null;
  const context = pageName || libraryPath || onBrand
    ? { ...(pageName ? { page: pageName } : onBrand ? { page: "Brand" } : {}), route: pathname, ...(libraryPath ? { libraryPath } : {}) }
    : null;

  const [contextFor, setContextFor] = useState(pathname);
  if (contextFor !== pathname) {
    setContextFor(pathname);
    setWithContext(true);
  }

  const report = useCallback((failure) => {
    setError(failure?.message ?? "Something went wrong. Try again.");
  }, []);

  /** Shows a conversation, and keeps watching its last turn if that is still being answered. */
  const show = useCallback((next) => {
    setConversation(next);
    setSteps([]);
    const last = next?.messages?.at(-1);
    setPending(last?.role === "assistant" && last.runId && IN_FLIGHT.includes(last.status)
      ? { runId: last.runId, conversationId: next.id }
      : null);
    rememberThread(workspaceId, next?.id ?? null);
  }, [workspaceId]);

  // The conversation that was open when the panel was last used, reopened the first time it opens.
  // The shell keys the panel by workspace, so a workspace switch starts this over.
  const restored = useRef(false);
  useEffect(() => {
    if (!panel?.open || restored.current) return undefined;
    restored.current = true;
    const stored = rememberedThread(workspaceId);
    if (!stored) return undefined;
    api.getConversation(workspaceId, stored)
      .then((response) => show(response.conversation))
      // A thread deleted elsewhere, or one from before a reset, is simply forgotten.
      .catch(() => rememberThread(workspaceId, null));
    return undefined;
  }, [panel?.open, workspaceId, show]);

  // A question put in the box from elsewhere — the Library's quick switcher, an `/ask?q=` link.
  const [draftSeq, setDraftSeq] = useState(0);
  const draft = panel?.draft;
  if (draft && draft.seq !== draftSeq) {
    setDraftSeq(draft.seq);
    setQuestion(draft.text);
    setShowHistory(false);
  }

  // The box takes the cursor when the panel opens or a question is put in it.
  useEffect(() => {
    if (panel?.open) box.current?.focus();
  }, [panel?.open, draftSeq]);

  // While a message is in flight the run's events are the progress. When it finishes the
  // conversation is re-read, which is when the answer — and the list of what it changed — is
  // folded into the waiting turn. If it changed the Library, every cached read of this workspace is
  // refreshed, so the Library on screen shows the change without a reload.
  useRunEvents({
    workspaceId,
    runId: pending?.runId ?? null,
    after: steps.at(-1)?.seq ?? 0,
    intervalMs: POLL_INTERVAL_MS,
    onEvents: (items) => setSteps((current) => [...current, ...items]),
    onComplete: async (_runId, isCurrent) => {
      const response = await api.getConversation(workspaceId, pending.conversationId);
      if (!isCurrent()) return;
      setConversation(response.conversation);
      setPending(null);
      setSteps([]);
      const answer = response.conversation.messages?.at(-1);
      // A brand turn's changes are shown on the Brand page beside the panel, so it is re-read too.
      if (answer?.changes?.length || answer?.brandChanges?.length) await revalidateWorkspace();
      else await mutateThreads();
    },
    onError: (failure) => {
      setPending(null);
      report(failure);
    },
  });

  /**
   * Uploads files to the brand, each shown as a chip while it goes, and returns the ones stored.
   * A file the API refuses stays as a chip saying why until it is removed.
   */
  async function upload(list, hint) {
    const chosen = Array.from(list ?? []).slice(0, MAX_FILES);
    if (!chosen.length) return [];
    const placeholders = chosen.map((file) => ({ key: `${file.name}-${file.size}-${Math.random()}`, fileName: file.name, uploading: true }));
    setFiles((current) => [...current, ...placeholders].slice(-MAX_FILES));
    const stored = [];
    await Promise.all(chosen.map(async (file, index) => {
      const key = placeholders[index].key;
      try {
        const response = await uploadBrandFile(workspaceId, file, hint);
        const chip = { key, id: response.asset.id, fileName: response.asset.fileName ?? file.name, kind: response.asset.kind, mimeType: response.asset.mimeType, pages: response.asset.document?.pages ?? null, font: response.asset.font ?? null };
        stored[index] = chip;
        setFiles((current) => current.map((entry) => (entry.key === key ? chip : entry)));
      } catch (failure) {
        setFiles((current) => current.map((entry) => (entry.key === key ? { key, fileName: file.name, error: failure?.message ?? "Not uploaded." } : entry)));
      }
    }));
    return stored.filter(Boolean);
  }

  /** Uploads dropped files and sends them at once, with what was typed or a line that says so. */
  async function dropFiles(list, section) {
    if (!takesFiles || pending || busy) return;
    setShowHistory(false);
    const stored = await upload(list, section);
    if (stored.length) await send(question, { section, attached: stored });
  }

  // Files dropped on the page itself — a section of the Brand page — are uploaded and sent here.
  const [droppedSeq, setDroppedSeq] = useState(0);
  const dropped = panel?.dropped;
  useEffect(() => {
    if (!dropped || dropped.seq === droppedSeq) return;
    setDroppedSeq(dropped.seq);
    dropFiles(dropped.files, dropped.section);
    // Only a new drop starts this; the functions it calls read the state as it is now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropped]);

  /**
   * Sends a message, into this thread or a new one, with the files attached to it.
   *
   * @param {string} text what was typed
   * @param {object} [options]
   * @param {string|null} [options.section] where on the Brand page files were dropped
   * @param {object[]} [options.attached] files just uploaded for this message, beside the chips
   */
  async function send(text, { section = null, attached = [] } = {}) {
    const ready = [...files.filter((file) => file.id), ...attached].filter((file, index, all) => all.findIndex((other) => other.id === file.id) === index);
    const asked = String(text ?? "").trim() || (ready.length ? filesOnly(ready.length) : "");
    if (!asked || pending || busy) return;
    if (files.some((file) => file.uploading)) return;
    setBusy(true);
    setError(null);
    setShowHistory(false);
    const base = withContext ? context : onBrand ? { page: "Brand", route: pathname } : null;
    const sentContext = base && section ? { ...base, section } : base;
    const attachments = ready.map((file) => file.id);
    try {
      const response = conversation
        ? await api.askFollowUp(workspaceId, conversation.id, asked, sentContext, attachments)
        : await api.startConversation(workspaceId, asked, sentContext, attachments);
      setQuestion("");
      setFiles([]);
      setSteps([]);
      setConversation(response.conversation);
      rememberThread(workspaceId, response.conversation.id);
      // A message whose run could not be created comes back already answered, with the reason on
      // the turn. Polling for a run that does not exist would only produce a second error.
      setPending(response.runId ? { runId: response.runId, conversationId: response.conversation.id } : null);
      await mutateThreads();
    } catch (failure) {
      report(failure);
    } finally {
      setBusy(false);
    }
  }

  /** Starts afresh. The old thread stays in the history. */
  function startNew() {
    setConversation(null);
    setPending(null);
    setSteps([]);
    setError(null);
    setShowHistory(false);
    rememberThread(workspaceId, null);
    box.current?.focus();
  }

  /** Opens one thread from the history. */
  async function openThread(conversationId) {
    setBusy(true);
    setError(null);
    try {
      const response = await api.getConversation(workspaceId, conversationId);
      show(response.conversation);
      setShowHistory(false);
    } catch (failure) {
      report(failure);
    } finally {
      setBusy(false);
    }
  }

  /** Removes a thread, and clears the panel when it was the one open. */
  async function remove(conversationId) {
    setBusy(true);
    try {
      await api.deleteConversation(workspaceId, conversationId);
      if (conversation?.id === conversationId) {
        setConversation(null);
        setPending(null);
        rememberThread(workspaceId, null);
      }
      await mutateThreads();
    } catch (failure) {
      report(failure);
    } finally {
      setBusy(false);
    }
  }

  // A new turn is what somebody is waiting for, and an answer that arrives below the fold looks
  // like one that never arrived.
  const turns = conversation?.messages?.length ?? 0;
  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [turns, pending, steps.length]);

  if (!panel?.open) return null;

  const messages = conversation?.messages ?? [];
  const lastAssistant = messages.at(-1)?.role === "assistant" ? messages.at(-1) : null;

  return (
    <aside
      aria-label="Ask"
      onDragOver={(event) => { if (takesFiles && carriesFiles(event)) event.preventDefault(); }}
      onDrop={(event) => {
        if (!takesFiles || !carriesFiles(event)) return;
        event.preventDefault();
        dropFiles(event.dataTransfer.files, "chat");
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          panel.setOpen(false);
        }
      }}
      className={cn(
        // Below `md` the panel covers the page: a column beside it would leave both unreadable.
        // From `md` up it is a column of the shell, beside the page rather than over it, so what an
        // answer cites can be opened and read with the conversation still in view.
        "fixed inset-0 z-40 flex flex-col overflow-hidden bg-orb-space",
        "md:relative md:z-auto md:shrink-0 md:rounded-xl md:border md:border-orb-line",
        panel.wide ? "md:w-[38rem]" : "md:w-[25rem]",
      )}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-xl border-2 border-dashed border-orb-lime/70 bg-orb-space/90 p-6 text-center">
          <div className="space-y-1.5">
            <FileUp aria-hidden="true" className="mx-auto size-6 text-orb-lime" />
            <p className="text-sm font-medium text-orb-white">Drop to add to your brand</p>
            <p className="text-xs text-orb-muted">Logos and images, brand guidelines (PDF), fonts, design tokens (JSON, CSS)</p>
          </div>
        </div>
      )}
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-orb-line pl-3.5 pr-1.5">
        <MessagesSquare aria-hidden="true" className="size-4 text-orb-lime" />
        <h2 className="ml-1 min-w-0 flex-1 truncate text-sm font-medium text-orb-white">
          {showHistory ? "Conversations" : conversation?.title ?? "Ask"}
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Conversations"
          aria-pressed={showHistory}
          className={cn("text-orb-muted hover:text-orb-white", showHistory && "bg-orb-raised text-orb-white")}
          onClick={() => setShowHistory((current) => !current)}
        >
          <History aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="New conversation"
          className="text-orb-muted hover:text-orb-white"
          onClick={startNew}
          disabled={busy}
        >
          <MessageSquarePlus aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={panel.wide ? "Narrow the panel" : "Widen the panel"}
          className="hidden text-orb-muted hover:text-orb-white md:inline-flex"
          onClick={() => panel.setWide((current) => !current)}
        >
          {panel.wide ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Close Ask (${ASK_SHORTCUT})`}
          className="text-orb-muted hover:text-orb-white"
          onClick={() => panel.setOpen(false)}
        >
          <X aria-hidden="true" />
        </Button>
      </header>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3.5 py-4">
        {showHistory ? (
          <ThreadList
            threads={threads}
            loading={!threadsRead.data && !threadsRead.error}
            currentId={conversation?.id ?? null}
            busy={busy}
            onOpen={openThread}
            onRemove={remove}
          />
        ) : (
          <div className="space-y-5">
            {!messages.length && !pending && (
              <div className="space-y-4 pt-2">
                <div className="space-y-1.5">
                  <p className="font-display text-lg font-bold tracking-[-0.02em] text-orb-white">{onBrand ? "Shape your brand" : "What can I do for you?"}</p>
                  {onBrand && canWrite ? (
                    <p className="text-sm text-orb-gray">
                      Drop files here or on any section of the page — a sharper logo, your brand
                      guidelines, a font, design tokens — or tell me what’s off. I’ll update the
                      brand as you, and every change can be undone.
                    </p>
                  ) : onBrand ? (
                    <p className="text-sm text-orb-gray">
                      Ask about the brand: its colours, fonts, logos and rules. Your role here is
                      read-only, so changing it needs a member.
                    </p>
                  ) : canWrite ? (
                    <p className="text-sm text-orb-gray">
                      Ask about your business and get answers from your own site and Library, with a
                      source under every claim. Or tell me to save something to the Library, or to
                      rearrange it — I’ll do it as you, and ask first before anything big.
                    </p>
                  ) : (
                    <p className="text-sm text-orb-gray">
                      Ask about your business and get answers from your own site and Library, with a
                      source under every claim. Your role here is read-only, so I answer questions;
                      saving to the Library or rearranging it needs a member.
                    </p>
                  )}
                </div>
                <ul className="space-y-1.5">
                  {(onBrand ? (canWrite ? BRAND_STARTERS : []) : STARTERS.filter((starter) => canWrite || !starter.writes)).map((starter) => (
                    <li key={starter.label}>
                      <button
                        type="button"
                        onClick={() => {
                          setQuestion(starter.text);
                          if (starter.attach) picker.current?.click();
                          else box.current?.focus();
                        }}
                        className="w-full rounded-lg border border-orb-line px-3 py-2 text-left text-sm text-orb-gray outline-none transition-colors hover:border-orb-muted hover:text-orb-white focus-visible:ring-2 focus-visible:ring-ring/70"
                      >
                        {starter.label}
                      </button>
                    </li>
                  ))}
                </ul>
                {!onBrand && <IndexStatus index={index} />}
              </div>
            )}

            {messages.length > 0 && (
              <ol className="space-y-5">
                {messages.map((message) => (
                  <Answer
                    key={message.id}
                    message={message}
                    workspaceId={workspaceId}
                    pending={Boolean(pending) && message === lastAssistant}
                    latest={message === lastAssistant}
                    onReply={send}
                    onRevise={() => box.current?.focus()}
                    onBrandChanged={revalidateWorkspace}
                    canChange={canWrite}
                  />
                ))}
              </ol>
            )}

            {/* The run's own steps, while it is working: "Searching what your site says" and
                "created /01-company/bios" say more than a spinner, and they are the truth. */}
            {pending && steps.length > 0 && (
              <ol className="space-y-1 border-l border-orb-line pl-3 text-xs text-orb-muted" aria-label="Progress">
                {steps.slice(-5).map((step) => (
                  <li key={step.seq} className="truncate">{describeStep(step)}</li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>

      <form
        onSubmit={(event) => { event.preventDefault(); send(question); }}
        className="shrink-0 space-y-2 border-t border-orb-line p-3"
      >
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {context && withContext && (
          <p className="flex items-center gap-1.5 text-2xs text-orb-muted">
            <span className="inline-flex min-w-0 items-center gap-1 rounded-md border border-orb-line py-0.5 pl-2 pr-0.5">
              <span className="truncate">
                {context.page ?? "This page"}
                {context.libraryPath ? ` · ${context.libraryPath}` : ""}
              </span>
              <button
                type="button"
                aria-label="Don’t send where I am"
                onClick={() => setWithContext(false)}
                className="grid size-4 shrink-0 place-items-center rounded hover:bg-orb-raised hover:text-orb-white"
              >
                <X aria-hidden="true" className="size-3" />
              </button>
            </span>
          </p>
        )}
        {files.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Attached files">
            {files.map((file) => (
              <li key={file.key ?? file.id}>
                <FileChip workspaceId={workspaceId} file={file} onRemove={() => setFiles((current) => current.filter((entry) => entry !== file))} />
              </li>
            ))}
          </ul>
        )}
        <div className="relative rounded-xl border border-orb-line bg-orb-black/40 focus-within:border-orb-muted">
          <textarea
            ref={box}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter breaks the line: the convention every chat uses.
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                send(question);
              }
            }}
            rows={3}
            maxLength={MAX_QUESTION}
            placeholder={onBrand && canWrite ? "Say what to change, or drop a file…" : conversation ? "Reply…" : canWrite ? "Ask, save, or rearrange…" : "Ask a question…"}
            aria-label="Message"
            disabled={Boolean(pending)}
            className={cn(
              "block max-h-48 min-h-[4.5rem] w-full resize-none bg-transparent px-3 py-2.5 pr-11 text-sm text-orb-white outline-none placeholder:text-orb-muted disabled:opacity-60",
              takesFiles && "pb-10",
            )}
          />
          {takesFiles && (
            <>
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,.svg,application/pdf,.pdf,.woff2,.woff,.otf,.ttf,application/json,.json,text/css,.css"
                onChange={(event) => {
                  upload(event.target.files, "chat");
                  event.target.value = "";
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Attach files"
                title="Attach logos, a brand guide, fonts or design tokens"
                className="absolute bottom-2 left-2 text-orb-muted hover:text-orb-white"
                onClick={() => picker.current?.click()}
                disabled={Boolean(pending) || files.length >= MAX_FILES}
              >
                <Paperclip aria-hidden="true" />
              </Button>
            </>
          )}
          <Button
            type="submit"
            size="icon-sm"
            aria-label="Send"
            className="absolute bottom-2 right-2"
            disabled={busy || Boolean(pending) || files.some((file) => file.uploading) || (!question.trim() && !files.some((file) => file.id))}
          >
            <ArrowUp aria-hidden="true" />
          </Button>
        </div>
        <p className="text-2xs text-orb-muted">
          {pending ? "Working…" : takesFiles ? `Enter to send · drop files anywhere on the page · ${ASK_SHORTCUT}` : `Enter to send · ${ASK_SHORTCUT} to open and close`}
        </p>
      </form>
    </aside>
  );
}

/** The history: every conversation in this workspace, most recently used first. */
function ThreadList({ threads, loading, currentId, busy, onOpen, onRemove }) {
  if (loading) return <p className="text-sm text-orb-muted">Loading…</p>;
  if (!threads.length) return <p className="text-sm text-orb-muted">Nothing asked yet.</p>;
  return (
    <ul className="space-y-0.5">
      {threads.map((thread) => (
        <li key={thread.id} className="group flex items-center gap-1">
          <button
            type="button"
            onClick={() => onOpen(thread.id)}
            aria-current={currentId === thread.id ? "true" : undefined}
            className={cn(
              "min-w-0 flex-1 rounded-lg px-2 py-1.5 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/70",
              currentId === thread.id ? "bg-orb-raised text-orb-white" : "text-orb-gray hover:bg-orb-raised/60 hover:text-orb-white",
            )}
          >
            <span className="block truncate">{thread.title}</span>
            <span className="block truncate text-2xs text-orb-muted">{formatDate(thread.updatedAt)}</span>
          </button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete “${thread.title}”`}
            className="shrink-0 text-orb-muted opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => onRemove(thread.id)}
            disabled={busy}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** One progress event, in the words a person reads. */
function describeStep(step) {
  const labels = {
    "content.search": "Searching what your site says",
    "content.readPages": "Reading a page",
    "library.read": "Opening a Library file",
    "library.tree": "Looking at the Library",
    "library.search": "Searching the Library",
    "library.write": "Writing a file",
    "library.mkdir": "Making a folder",
    "library.move": "Moving",
    "library.reorder": "Reordering",
    "library.delete": "Deleting",
    "brand.get": "Reading the brand",
    "brand.uploads": "Listing your files",
    "brand.viewFile": "Looking at a file",
    "brand.asset": "Looking at a logo",
    "brand.assets": "Listing the brand's images",
    "brand.set": "Setting",
    "brand.unset": "Handing back",
    "brand.setImage": "Updating an image",
  };
  switch (step.type) {
    case "started":
      return "Started";
    case "tool-started":
      return `${labels[step.tool] ?? step.tool}…`;
    case "tool-completed":
      return step.summary ? `${labels[step.tool] ?? step.tool} — ${step.summary}` : labels[step.tool] ?? step.tool;
    case "completed":
      return "Writing the reply";
    case "failed":
      return step.message;
    default:
      return step.message ?? step.type;
  }
}
