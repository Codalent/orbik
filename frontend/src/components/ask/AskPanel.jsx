"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import useSWR from "swr";
import {
  AlertCircle,
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  FileUp,
  FolderTree,
  History,
  ImageUp,
  Loader2,
  MapPin,
  MessageCircleQuestion,
  MessageSquare,
  NotebookPen,
  Palette,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Answer, Thinking } from "./Answer";
import { FileChip } from "./FileChip";
import { Button } from "@/components/ui/button";
import { OrbikMark } from "@/components/OrbikLogo";
import { IndexStatus } from "./IndexStatus";
import * as api from "@/lib/api/conversations";
import { uploadBrandFile } from "@/lib/api/brand";
import { carriesFiles, useFileDrag } from "@/lib/brand/useFileDrag";
import { useRevalidateWorkspace } from "@/lib/api/cache";
import { useRunEvents } from "@/lib/agents/useRunEvents";
import { useAiAvailability, aiUnavailableText } from "@/lib/ask/ai";
import { useAskPanel, useAskShortcut } from "@/lib/ask/askPanel";
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
  { label: "Replace the logo with a sharper file", text: "Here is our logo as a sharper file: ", attach: true, icon: ImageUp },
  { label: "Read our brand guidelines", text: "Here are our brand guidelines. ", attach: true, icon: BookOpen },
  { label: "Change a colour or a font", text: "Our primary colour is ", icon: Palette },
]);

/** Open layers that take Escape themselves: while one is on screen, Escape is theirs. */
const LAYERS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/** Fields where Escape means something to the field: cancel an edit, close a suggestion list. */
const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

/** How long the panel takes to close: the length of its width transition. */
const CLOSE_MS = 300;

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

/**
 * Ways in for a person who has not asked anything yet: one of each thing the panel does. A whole
 * question is sent when pressed; one that ends where the person is meant to go on is put in the box.
 */
const STARTERS = Object.freeze([
  { label: "What do we sell, and to whom?", text: "What do we sell, and to whom?", send: true, icon: MessageCircleQuestion },
  { label: "Save a note to the Library", text: "Save this to the Library: ", writes: true, icon: NotebookPen },
  { label: "Tidy up the Library", text: "Look at how the Library is arranged and suggest a tidier structure.", writes: true, icon: FolderTree },
]);

/**
 * Ask: a chat that opens beside every workspace page, as a column of its own that holds the app
 * (framed, by the shell) rather than a panel inside it.
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
  // Without a reasoning provider no question can be answered: said before anything is typed.
  const ai = useAiAvailability();
  const shortcut = useAskShortcut();

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
  const panelNode = useRef(null);
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
  // The shell keys the panel by workspace, so a workspace switch starts this over. Anything the
  // person does before it arrives — a question sent, a thread opened, a new one started — wins
  // over it, so a question asked the moment the panel opens is not replaced by an older thread.
  const restored = useRef(false);
  const superseded = useRef(false);
  useEffect(() => {
    if (!panel?.open || restored.current) return undefined;
    restored.current = true;
    const stored = rememberedThread(workspaceId);
    if (!stored) return undefined;
    api.getConversation(workspaceId, stored)
      .then((response) => { if (!superseded.current) show(response.conversation); })
      // A thread deleted elsewhere, or one from before a reset, is simply forgotten.
      .catch(() => rememberThread(workspaceId, null));
    return undefined;
  }, [panel?.open, workspaceId, show]);

  // A question put in the box from elsewhere — the Library's quick switcher, an `/ask?q=` link —
  // or asked from elsewhere, which is sent by the effect below rather than left in the box.
  const [draftSeq, setDraftSeq] = useState(0);
  const draft = panel?.draft;
  if (draft && draft.seq !== draftSeq) {
    setDraftSeq(draft.seq);
    if (!draft.send) setQuestion(draft.text);
    setShowHistory(false);
  }

  // The box takes the cursor when the panel opens or a question is put in it.
  useEffect(() => {
    if (panel?.open) box.current?.focus();
  }, [panel?.open, draftSeq]);

  // A question asked from elsewhere — Home's suggested questions — is sent at once, in a new
  // conversation. While another answer is still coming, or with no AI to answer, it is put in the
  // box instead, where the person can see it and why it was not sent.
  const askedSeq = useRef(0);
  useEffect(() => {
    if (!draft?.send || draft.seq === askedSeq.current) return;
    askedSeq.current = draft.seq;
    askNow(draft.text);
    // Only a new question asked from elsewhere starts this; `askNow` reads the state as it is now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  // Escape closes the panel from anywhere on the page, not only from inside it — unless something
  // on top of the page is open and takes Escape itself (a dialog, a menu, a list of options), or
  // the cursor is in a field of the page, where Escape belongs to the field. Those handlers that
  // mark the key as handled (`preventDefault`) are respected too.
  const setPanelOpen = panel?.setOpen;
  const isOpen = Boolean(panel?.open);
  useEffect(() => {
    if (!isOpen || !setPanelOpen) return undefined;
    function onKeyDown(event) {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const node = panelNode.current;
      const target = event.target instanceof Element ? event.target : null;
      if (!node?.contains(target)) {
        if (target?.closest(EDITABLE)) return;
        if ([...document.querySelectorAll(LAYERS)].some((layer) => !node?.contains(layer))) return;
      }
      event.preventDefault();
      setPanelOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen, setPanelOpen]);

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
   * @param {boolean} [options.fresh] in a new conversation, whatever thread is open
   */
  async function send(text, { section = null, attached = [], fresh = false } = {}) {
    const ready = [...files.filter((file) => file.id), ...attached].filter((file, index, all) => all.findIndex((other) => other.id === file.id) === index);
    const asked = String(text ?? "").trim() || (ready.length ? filesOnly(ready.length) : "");
    if (!asked || pending || busy) return;
    if (files.some((file) => file.uploading)) return;
    superseded.current = true;
    setBusy(true);
    setError(null);
    setShowHistory(false);
    const thread = fresh ? null : conversation;
    const base = withContext ? context : onBrand ? { page: "Brand", route: pathname } : null;
    const sentContext = base && section ? { ...base, section } : base;
    const attachments = ready.map((file) => file.id);
    try {
      const response = thread
        ? await api.askFollowUp(workspaceId, thread.id, asked, sentContext, attachments)
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

  /** Asks a question from elsewhere at once, or puts it in the box when it cannot be sent now. */
  function askNow(text) {
    if (pending || busy || !ai.reasoning) {
      setQuestion(text);
      return;
    }
    send(text, { fresh: true });
  }

  /** Starts afresh. The old thread stays in the history. */
  function startNew() {
    superseded.current = true;
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
    superseded.current = true;
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

  // The panel closing is seen as well as its opening: it stays on screen for the length of its
  // transition, narrowing to nothing while the frame beside it takes the room back.
  const [shown, setShown] = useState(isOpen);
  if (isOpen && !shown) setShown(true);
  useEffect(() => {
    if (isOpen || !shown) return undefined;
    const timer = setTimeout(() => setShown(false), CLOSE_MS);
    return () => clearTimeout(timer);
  }, [isOpen, shown]);

  // While an answer is in flight the shell lights the frame round the app: what Ask does, it does
  // in there. Put out when the panel goes, so a closed panel leaves nothing lit.
  const setWorking = panel?.setWorking;
  const working = Boolean(pending);
  useEffect(() => {
    setWorking?.(working);
  }, [setWorking, working]);
  useEffect(() => () => setWorking?.(false), [setWorking]);

  if (!shown) return null;

  const closing = !isOpen;
  const messages = conversation?.messages ?? [];
  const lastAssistant = messages.at(-1)?.role === "assistant" ? messages.at(-1) : null;
  const starters = !ai.reasoning ? [] : onBrand ? (canWrite ? BRAND_STARTERS : []) : STARTERS.filter((starter) => canWrite || !starter.writes);
  const canSend = !busy && !pending && ai.reasoning && !files.some((file) => file.uploading) && Boolean(question.trim() || files.some((file) => file.id));

  return (
    <aside
      ref={panelNode}
      aria-label="Ask"
      inert={closing}
      onDragOver={(event) => { if (takesFiles && carriesFiles(event)) event.preventDefault(); }}
      onDrop={(event) => {
        if (!takesFiles || !carriesFiles(event)) return;
        event.preventDefault();
        dropFiles(event.dataTransfer.files, "chat");
      }}
      className={cn(
        // Below `md` Ask covers the page: a column beside it would leave both unreadable. From `md`
        // up it is a column of its own on the surround, beside the framed app rather than inside
        // it, so what an answer cites can be opened and read with the conversation still in view.
        "fixed inset-0 z-40 flex flex-col bg-orb-black max-md:animate-in max-md:fade-in max-md:slide-in-from-bottom-4",
        "md:relative md:inset-auto md:z-auto md:shrink-0 md:overflow-hidden md:bg-transparent",
        "md:animate-[orbik-ask-in_320ms_cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:animate-none",
        "transition-[width,opacity] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none",
        closing ? "pointer-events-none opacity-0 md:w-0" : panel.wide ? "md:w-[38rem]" : "md:w-[25rem]",
      )}
    >
      {/* At least the narrow width while the column grows or shrinks, so the words inside do not
          reflow on every frame of it. */}
      <div className="flex h-full min-h-0 flex-col md:w-full md:min-w-[25rem]">
        <header className="flex h-11 shrink-0 items-center gap-2 pl-3 pr-1.5 md:pl-1.5 md:pr-0">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-orb-line bg-orb-raised/60">
            <OrbikMark className="size-4 text-orb-logo" />
          </span>
          <h2 className="flex min-w-0 flex-1 items-baseline gap-2 text-sm">
            <span className="shrink-0 font-semibold text-orb-white">Ask</span>
            {(showHistory || conversation?.title) && (
              <span className="min-w-0 truncate text-compact text-orb-muted">
                {showHistory ? "Conversations" : conversation.title}
              </span>
            )}
          </h2>
          <div className="flex shrink-0 items-center">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Conversations"
              title="Conversations"
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
              title="New conversation"
              className="text-orb-muted hover:text-orb-white"
              onClick={startNew}
              disabled={busy}
            >
              <SquarePen aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={panel.wide ? "Narrow Ask" : "Widen Ask"}
              title={panel.wide ? "Narrow" : "Widen"}
              className="hidden text-orb-muted hover:text-orb-white md:inline-flex"
              onClick={() => panel.setWide((current) => !current)}
            >
              {panel.wide ? <PanelRightClose aria-hidden="true" /> : <PanelRightOpen aria-hidden="true" />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={shortcut ? `Close Ask (${shortcut})` : "Close Ask"}
              title={shortcut ? `Close (${shortcut})` : "Close"}
              className="text-orb-muted hover:text-orb-white"
              onClick={() => panel.setOpen(false)}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        </header>

        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden border-t border-orb-line bg-orb-space md:rounded-2xl md:border md:border-(--ask-edge) md:shadow-[0_30px_80px_-30px_rgb(0_0_0/0.85)]">
          {dragging && (
            <div className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-xl border-2 border-dashed border-orb-lime/70 bg-orb-space/90 p-6 text-center">
              <div className="space-y-1.5">
                <FileUp aria-hidden="true" className="mx-auto size-6 text-orb-lime" />
                <p className="text-sm font-medium text-orb-white">Drop to add to your brand</p>
                <p className="text-xs text-orb-muted">Logos and images, brand guidelines (PDF), fonts, design tokens (JSON, CSS)</p>
              </div>
            </div>
          )}

          {/* The conversation fades out under the composer rather than being cut off by it. */}
          <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-5 [mask-image:linear-gradient(to_bottom,black_calc(100%-1.25rem),transparent)]">
            {showHistory ? (
              <ThreadList
                threads={threads}
                loading={!threadsRead.data && !threadsRead.error}
                currentId={conversation?.id ?? null}
                busy={busy}
                onOpen={openThread}
                onRemove={remove}
              />
            ) : !messages.length && !pending ? (
              <div className="flex min-h-full flex-col justify-center gap-6 pb-4">
                <div className="space-y-3">
                  <span className="relative grid size-11 place-items-center rounded-2xl border border-orb-line bg-orb-raised/60">
                    <OrbikMark className="size-6 text-orb-logo" />
                  </span>
                  <p className="font-display text-xl font-bold tracking-[-0.02em] text-orb-white">{onBrand ? "Shape your brand" : "What can I do for you?"}</p>
                  <p className="text-sm leading-relaxed text-orb-gray">{greeting(onBrand, canWrite)}</p>
                </div>
                {starters.length > 0 && (
                  <ul className="space-y-1.5">
                    {starters.map((starter) => {
                      const Icon = starter.icon;
                      return (
                        <li key={starter.label}>
                          <button
                            type="button"
                            onClick={() => {
                              if (starter.send) {
                                send(starter.text);
                                return;
                              }
                              setQuestion(starter.text);
                              if (starter.attach) picker.current?.click();
                              else box.current?.focus();
                            }}
                            className="group flex w-full items-center gap-3 rounded-xl border border-orb-line bg-orb-raised/30 px-3 py-2.5 text-left text-sm text-orb-gray outline-none transition-colors hover:border-orb-muted/60 hover:bg-orb-raised/70 hover:text-orb-white focus-visible:ring-2 focus-visible:ring-ring/70"
                          >
                            <Icon aria-hidden="true" className="size-4 shrink-0 text-orb-muted transition-colors group-hover:text-orb-lime" />
                            <span className="min-w-0 flex-1">{starter.label}</span>
                            <ArrowUpRight aria-hidden="true" className="size-3.5 shrink-0 text-orb-muted opacity-0 transition-opacity group-hover:opacity-100" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {!onBrand && <IndexStatus index={index} />}
              </div>
            ) : (
              <ol className="space-y-7">
                {messages.map((message) => (
                  <Answer
                    key={message.id}
                    message={message}
                    workspaceId={workspaceId}
                    pending={Boolean(pending) && message === lastAssistant}
                    progress={message === lastAssistant ? steps : []}
                    latest={message === lastAssistant}
                    onReply={send}
                    onRevise={() => box.current?.focus()}
                    onBrandChanged={revalidateWorkspace}
                    canChange={canWrite}
                  />
                ))}
                {/* A run under way whose turn has not come back yet: its steps all the same. */}
                {pending && !lastAssistant && <li><Thinking steps={steps} /></li>}
              </ol>
            )}
          </div>

          <form
            onSubmit={(event) => { event.preventDefault(); send(question); }}
            className="shrink-0 space-y-2 px-3 pb-3"
          >
            {/* Said before anything is typed: a question asked now could only fail. */}
            {!ai.reasoning && (
              <p role="status" className="flex items-start gap-2 px-1 text-xs leading-relaxed text-orb-gray">
                <AlertCircle aria-hidden="true" className="mt-px size-3.5 shrink-0 text-orb-orange" />
                <span>{aiUnavailableText(onBrand ? "Ask cannot answer or change the brand" : "Ask cannot answer questions or change the Library", { isAdmin: ai.isAdmin })}</span>
              </p>
            )}
            {error && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="rounded-2xl border border-orb-line bg-orb-raised/40 shadow-[0_8px_24px_-16px_rgb(0_0_0/0.6)] transition-colors focus-within:border-orb-muted/70 focus-within:bg-orb-raised/60">
              {files.length > 0 && (
                <ul className="flex flex-wrap gap-1.5 px-2.5 pt-2.5" aria-label="Attached files">
                  {files.map((file) => (
                    <li key={file.key ?? file.id}>
                      <FileChip workspaceId={workspaceId} file={file} onRemove={() => setFiles((current) => current.filter((entry) => entry !== file))} />
                    </li>
                  ))}
                </ul>
              )}
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
                rows={2}
                maxLength={MAX_QUESTION}
                placeholder={onBrand && canWrite ? "Say what to change, or drop a file…" : conversation ? "Reply…" : canWrite ? "Ask, save, or rearrange…" : "Ask a question…"}
                aria-label="Message"
                disabled={Boolean(pending) || !ai.reasoning}
                // Grows with what is typed, up to a few lines, where the browser can size a field
                // by its content; elsewhere it stays at two lines and scrolls.
                className="block max-h-48 min-h-[3.25rem] w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-sm text-orb-white outline-none [field-sizing:content] placeholder:text-orb-muted disabled:opacity-60"
              />
              <div className="flex items-center gap-1.5 px-2 pb-2">
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
                      className="shrink-0 rounded-full text-orb-muted hover:text-orb-white"
                      onClick={() => picker.current?.click()}
                      disabled={Boolean(pending) || !ai.reasoning || files.length >= MAX_FILES}
                    >
                      <Paperclip aria-hidden="true" />
                    </Button>
                  </>
                )}
                {context && withContext && (
                  // What the chip is, said where it is: it is sent with the question as a hint, and
                  // takes nothing out of what is searched. On the Brand page the page is what makes
                  // the brand chat answer, so it stays, and there is nothing to remove.
                  <span
                    title={contextHint(context, onBrand)}
                    className={cn(
                      "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-full border border-orb-line bg-orb-space/60 pl-2.5 text-2xs text-orb-gray",
                      onBrand ? "pr-2.5" : "pr-1",
                    )}
                  >
                    <MapPin aria-hidden="true" className="size-3 shrink-0 text-orb-muted" />
                    <span className="truncate">
                      <span className="sr-only">Asking from: </span>
                      {context.page ?? "This page"}
                      {context.libraryPath ? ` · ${context.libraryPath}` : ""}
                    </span>
                    {!onBrand && (
                      <button
                        type="button"
                        aria-label="Ask without this page"
                        title="Ask without this page"
                        onClick={() => setWithContext(false)}
                        className="grid size-5 shrink-0 place-items-center rounded-full text-orb-muted hover:bg-orb-raised hover:text-orb-white"
                      >
                        <X aria-hidden="true" className="size-3" />
                      </button>
                    )}
                  </span>
                )}
                <Button
                  type="submit"
                  size="icon-sm"
                  aria-label="Send"
                  className="ml-auto shrink-0 rounded-full disabled:bg-orb-raised disabled:text-orb-muted disabled:opacity-100"
                  disabled={!canSend}
                >
                  {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : <ArrowUp aria-hidden="true" />}
                </Button>
              </div>
            </div>
            <p className="text-center text-2xs text-orb-muted">
              {pending
                ? "Working… you can keep using Orbik meanwhile."
                : (takesFiles
                  ? ["Enter to send", "drop files anywhere on the page", shortcut]
                  : ["Answers cite their sources", "Enter to send", shortcut && `${shortcut} to close`]).filter(Boolean).join(" · ")}
            </p>
          </form>
        </div>
      </div>
    </aside>
  );
}

/** What the empty panel says it can do, for where the person is and what their role lets them. */
function greeting(onBrand, canWrite) {
  if (onBrand && canWrite) {
    return "Drop files here or on any section of the page — a sharper logo, your brand guidelines, a font, design tokens — or tell me what’s off. I’ll update the brand as you, and every change can be undone.";
  }
  if (onBrand) {
    return "Ask about the brand: its colours, fonts, logos and rules. Your role here is read-only, so changing it needs a member.";
  }
  if (canWrite) {
    return "Ask about your business and get answers from your own site and Library, with a source under every claim. Or tell me to save something to the Library, or to rearrange it — I’ll do it as you, and ask first before anything big.";
  }
  return "Ask about your business and get answers from your own site and Library, with a source under every claim. Your role here is read-only, so I answer questions; saving to the Library or rearranging it needs a member.";
}

/**
 * What the page chip means, for its tooltip. True to what is sent: the page (and on the Library the
 * file on screen) goes with the question as a hint for "this" and "here", and the search covers the
 * whole workspace with or without it.
 */
function contextHint(context, onBrand) {
  if (onBrand) return "Asked from the Brand page, so the brand chat answers: it reads the brand and can change it.";
  const what = context.libraryPath ? "the page and the Library file you are on" : "the page you are on";
  return `Sent with your question: ${what}, so “this” and “here” mean what is on screen. Ask searches the whole workspace either way; remove it to ask without pointing at this page.`;
}

/** The history: every conversation in this workspace, most recently used first. */
function ThreadList({ threads, loading, currentId, busy, onOpen, onRemove }) {
  if (loading) return <p className="px-1 text-sm text-orb-muted">Loading…</p>;
  if (!threads.length) return <p className="px-1 text-sm text-orb-muted">Nothing asked yet.</p>;
  return (
    <ul className="-mx-1.5 space-y-0.5">
      {threads.map((thread) => (
        <li key={thread.id} className="group flex items-center gap-1">
          <button
            type="button"
            onClick={() => onOpen(thread.id)}
            aria-current={currentId === thread.id ? "true" : undefined}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/70",
              currentId === thread.id ? "bg-orb-raised text-orb-white" : "text-orb-gray hover:bg-orb-raised/60 hover:text-orb-white",
            )}
          >
            <MessageSquare aria-hidden="true" className="size-3.5 shrink-0 text-orb-muted" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{thread.title}</span>
              <span className="block truncate text-2xs text-orb-muted">{formatDate(thread.updatedAt)}</span>
            </span>
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
