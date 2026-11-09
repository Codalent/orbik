import { toObjectId } from "@orbik/core";
import { AGENT_EVENT_TYPES, isTerminalRunStatus } from "@orbik/protocol";
import { randomUUID } from "node:crypto";

import { BRAND_ASSET_ORIGINS } from "@orbik/core";

import { AppError } from "../errors/appError.js";
import { toConversation, toConversationSummary } from "../repositories/conversationRepository.js";
import { toChangeView } from "./brandService.js";
import { createWorkspaceAccessCheck, hasRole } from "./workspaceAccess.js";

/** The agent that answers a question from the retrieval index, and saves and rearranges the Library. */
export const CHAT_AGENT_SLUG = "library-chat";

/**
 * The same agent for a person whose role is read-only: it answers, and has no tool that writes.
 * Which of the two a message starts is decided from the asker's role when the message is sent.
 */
export const CHAT_READ_AGENT_SLUG = "library-chat-read";

/**
 * Ask on the Brand page: the same panel and conversation, answered by the agent that builds the
 * brand from dropped files and what the person says. Chosen when a message is sent from the Brand
 * page, with its read-only variant for a read-only person.
 */
export const BRAND_CHAT_AGENT_SLUG = "brand-chat";
export const BRAND_CHAT_READ_AGENT_SLUG = "brand-chat-read";

/** Every agent whose runs are Ask's turns, for anything that tells chat apart from agent work. */
export const CHAT_AGENT_SLUGS = Object.freeze([CHAT_AGENT_SLUG, CHAT_READ_AGENT_SLUG, BRAND_CHAT_AGENT_SLUG, BRAND_CHAT_READ_AGENT_SLUG]);

/** The routes of the Brand page, where a message goes to the brand chat. */
const BRAND_ROUTE = /^\/workspaces\/[^/]+\/(?:brand|agents\/design-system)\/?$/;

/** Whether a message was sent from the Brand page. */
function fromBrandPage(context) {
  return context?.page === "Brand" || BRAND_ROUTE.test(context?.route ?? "");
}

/** Turns handed to the agent as context. Enough for "and for enterprise?" to mean something. */
const CONTEXT_TURNS = 6;

/** Characters of an earlier answer passed back as context, so a long thread stays a short prompt. */
const CONTEXT_CHARACTERS = 1_200;

/**
 * Characters of the latest answer passed back. More than the rest, because "save that to the
 * Library" is about the answer just given, and saving its first paragraph would be saving a
 * different thing.
 */
const LATEST_ANSWER_CHARACTERS = 8_000;

/**
 * The tools that change the Library. A finished run's completed calls to these are what the turn
 * reports as changed — read from the run's own events, so the list says what happened rather than
 * what the model said it did.
 */
const CHANGING_TOOLS = Object.freeze([
  "library.write",
  "library.mkdir",
  "library.move",
  "library.reorder",
  "library.delete",
]);

/** Changes listed on one turn; a reorganisation bigger than this is summarised by its count. */
const MAX_CHANGES = 60;

/** Longest question accepted. A question longer than this is a document, and belongs in the Library. */
export const MAX_QUESTION = 1_000;

/**
 * Asking a workspace's index a question, and keeping the thread.
 *
 * The shape worth explaining is how an answer gets into the conversation. Asking creates a run —
 * through the same service the Run button uses, so a chat answer has the same
 * ledger, the same cancellation and the same place in the history as any other agent run — and
 * stores a placeholder turn that names it. The answer is folded into that turn **when the
 * conversation is next read**, not by the worker.
 *
 * Reconciling on read rather than writing from the worker is the decision here, and it is worth
 * the sentence. The alternative is for the run handler to know about conversations: a chat-shaped
 * branch inside the one function that executes every agent, which would then have to be kept
 * correct through every future change to runs. Reading is also the only moment the answer is
 * actually needed. And it is self-healing in the case that matters most — a worker that crashed
 * after finishing the run, or an answer produced while nobody had the page open, is folded in the
 * first time somebody looks, rather than lost.
 *
 * @param {object} dependencies collaborators
 * @param {object} dependencies.workspaceRepository workspace access by owner or membership
 * @param {object} dependencies.conversationRepository conversation storage
 * @param {object} dependencies.runRepository agent run access, for reading an answer back
 * @param {object} dependencies.runService creates runs; chat does not invent a second way
 * @param {object} [dependencies.brandRepository] the brand's files and change log, for files sent
 *   with a message and for the changes a brand turn made
 */
export function createConversationService({
  workspaceRepository,
  conversationRepository,
  runRepository,
  runService,
  brandRepository = null,
}) {
  const requireWorkspaceAccess = createWorkspaceAccessCheck(workspaceRepository);

  /**
   * Resolves one of the caller's own conversations, with the same 404 for a missing workspace, a
   * missing conversation and somebody else's.
   *
   * A conversation is private to the person who started it: what someone asks Ask is theirs, and
   * other members of the workspace — the owner included — neither list it nor open it. A row that
   * records nobody predates members and is the owner's.
   */
  async function requireConversation(userId, workspaceId, conversationId) {
    const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "read-only" });
    const conversation = await conversationRepository.find({ workspaceId: workspace._id, conversationId });
    const startedBy = conversation?.userId ?? workspace.ownerId;
    if (!conversation || String(startedBy) !== String(userId)) {
      throw new AppError({ status: 404, code: "CONVERSATION_NOT_FOUND", message: "Conversation was not found." });
    }
    return { workspace, conversation };
  }

  /**
   * Folds finished runs into the turns that were waiting for them.
   *
   * Returns the conversation as it now stands, whether or not anything moved, so every read goes
   * through one path. A run that is still going leaves its turn alone — the interface polls the
   * run's events for that, exactly as it does for any other agent.
   */
  async function reconcile(workspaceId, conversation) {
    let current = conversation;
    for (const message of conversation.messages ?? []) {
      if (message.role !== "assistant" || !message.runId) continue;
      if (message.status && isTerminalRunStatus(message.status)) continue;

      const run = await runRepository.findInWorkspace(workspaceId, String(message.runId));
      if (!run || !isTerminalRunStatus(run.status)) continue;

      const changes = await changesOf(run._id);
      const brandChanges = brandRepository ? await brandRepository.listChangesForRuns({ workspaceId, runIds: [run._id] }) : [];
      const updated = await conversationRepository.replaceMessage({
        workspaceId,
        conversationId: conversation._id.toHexString(),
        messageId: message.id,
        message: { ...message, ...answerFrom(run), changes, brandChanges: brandChanges.map(toChangeView) },
      });
      if (updated) current = updated;
    }
    return current;
  }

  /**
   * Turns one question into a turn, a run, and the empty turn its answer will land in.
   *
   * The two turns are written before the run is created and the run identifier is written onto the
   * second one afterwards, so a failure to create the run — no such agent —
   * leaves a question with a failed answer beside it rather than a question that appears to be
   * still thinking, forever.
   *
   * Every role may ask. Which agent answers is the asker's role at this moment, read from the
   * workspace the access check just resolved: a member or above gets Ask that can save and
   * rearrange, a read-only person the variant with only the tools that read. The guard is the
   * tool set, so the worker never has to know about roles.
   */
  async function ask({ userId, workspace, conversation, question, context = null, attachments = [] }) {
    const at = new Date();
    const files = await attachedFiles(workspace, attachments);
    const brand = fromBrandPage(context) || files.length > 0;
    // `startedBy` on the question, as on the run it starts: whose turn this was, kept on the turn
    // itself so the record does not depend on the conversation staying one person's.
    const userMessage = {
      id: randomUUID(),
      role: "user",
      text: question,
      ...(context ? { context } : {}),
      ...(files.length ? { attachments: files } : {}),
      at,
      startedBy: toObjectId(userId),
    };
    const assistantMessage = { id: randomUUID(), role: "assistant", status: "queued", runId: null, at };

    const history = contextFrom(conversation);
    let stored = conversation
      ? await conversationRepository.append({
        workspaceId: workspace._id,
        conversationId: conversation._id.toHexString(),
        messages: [userMessage, assistantMessage],
        at,
      })
      : await conversationRepository.create({
        workspaceId: workspace._id,
        userId,
        title: titleFor(question),
        messages: [userMessage, assistantMessage],
        at,
      });

    let run;
    try {
      ({ run } = await runService.createRun({
        userId,
        workspaceId: workspace._id.toHexString(),
        agentSlug: brand
          ? hasRole(workspace.role, "member") ? BRAND_CHAT_AGENT_SLUG : BRAND_CHAT_READ_AGENT_SLUG
          : hasRole(workspace.role, "member") ? CHAT_AGENT_SLUG : CHAT_READ_AGENT_SLUG,
        // Read-only is enough to start an Ask run; the slug above is what keeps it from writing.
        minimumRole: "read-only",
        input: {
          question,
          ...(history.length ? { history } : {}),
          // The Ask agents take no `section`: it is the Brand page's alone.
          ...(agentContext(context, brand) ? { context: agentContext(context, brand) } : {}),
          ...(brand && files.length ? { attachments: files.map(({ id, fileName, kind, mimeType }) => ({ id, fileName: fileName ?? "", kind, mimeType })) } : {}),
        },
        requestKey: `${stored._id.toHexString()}:${assistantMessage.id}`,
      }));
    } catch (error) {
      // The run could not be created at all. Recorded on the turn, in the words the person needs,
      // rather than left as a question that never gets answered.
      const failed = await conversationRepository.replaceMessage({
        workspaceId: workspace._id,
        conversationId: stored._id.toHexString(),
        messageId: assistantMessage.id,
        message: {
          ...assistantMessage,
          status: "failed",
          error: { code: error.code ?? "RUN_NOT_CREATED", message: error.message },
        },
      });
      return { conversation: toConversation(failed ?? stored), runId: null };
    }

    stored = await conversationRepository.replaceMessage({
      workspaceId: workspace._id,
      conversationId: stored._id.toHexString(),
      messageId: assistantMessage.id,
      message: { ...assistantMessage, runId: run._id, status: run.status },
    }) ?? stored;

    return { conversation: toConversation(stored), runId: run._id.toHexString() };
  }

  /**
   * The files a person sent with a message, each one of this workspace's uploads, as the turn
   * records them. An identifier that is not one of them is refused, not dropped: a message that
   * silently lost its file would be answered as if the person had sent nothing.
   */
  async function attachedFiles(workspace, ids) {
    if (!ids?.length) return [];
    if (!brandRepository) throw new AppError({ status: 400, code: "ATTACHMENTS_UNSUPPORTED", message: "Files cannot be sent here." });
    const files = [];
    for (const id of ids) {
      const asset = await brandRepository.findAsset({ workspaceId: workspace._id, assetId: id });
      if (!asset || asset.origin !== BRAND_ASSET_ORIGINS.upload) {
        throw new AppError({ status: 400, code: "ATTACHMENT_INVALID", message: "One of the attached files is not one of this brand's uploads." });
      }
      files.push({
        id: asset._id.toHexString(),
        fileName: asset.fileName ?? null,
        kind: asset.kind,
        mimeType: asset.mimeType,
        bytes: asset.bytes,
        width: asset.width ?? null,
        height: asset.height ?? null,
        pages: asset.document?.pages ?? null,
        font: asset.font ? { family: asset.font.family, weight: asset.font.weight } : null,
      });
    }
    return files;
  }

  /**
   * What a finished run changed in the Library, from its own events: every completed call to a
   * tool that writes, with the line the worker recorded for it ("created /01-company/bios",
   * "moved /a to /b"). A refused call is recorded as "failed" and is not a change.
   */
  async function changesOf(runId) {
    const events = await runRepository.listEvents({ runId, after: 0, limit: 1_000 });
    const changes = [];
    for (const event of events) {
      if (event.type !== AGENT_EVENT_TYPES.toolCompleted) continue;
      const tool = event.data?.tool;
      const summary = event.data?.summary;
      if (!CHANGING_TOOLS.includes(tool) || typeof summary !== "string" || !summary || summary === "failed") continue;
      changes.push({ tool, summary: summary.slice(0, 300) });
    }
    if (changes.length <= MAX_CHANGES) return changes;
    return [
      ...changes.slice(0, MAX_CHANGES - 1),
      { tool: null, summary: `and ${(changes.length - MAX_CHANGES + 1).toLocaleString("en-US")} more changes` },
    ];
  }

  return {
    /** A workspace's conversations, most recently used first. */
    async listConversations({ userId, workspaceId, limit }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "read-only" });
      const rows = await conversationRepository.list({
        workspaceId: workspace._id,
        userId,
        includeUnattributed: workspace.role === "owner",
        limit,
      });
      return { items: rows.map(toConversationSummary) };
    },

    /** One conversation, with any finished answers folded in. */
    async getConversation({ userId, workspaceId, conversationId }) {
      const { workspace, conversation } = await requireConversation(userId, workspaceId, conversationId);
      return { conversation: toConversation(await reconcile(workspace._id, conversation)) };
    },

    /** Starts a conversation with its first question. */
    async startConversation({ userId, workspaceId, question, context, attachments }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "read-only" });
      if (attachments?.length && !hasRole(workspace.role, "member")) {
        throw new AppError({ status: 403, code: "ROLE_INSUFFICIENT", message: "Only a member of this workspace can add files to the brand." });
      }
      return ask({ userId, workspace, conversation: null, question, context, attachments });
    },

    /** Asks a follow-up, which is answered with the turns before it as context. */
    async askFollowUp({ userId, workspaceId, conversationId, question, context, attachments }) {
      const { workspace, conversation } = await requireConversation(userId, workspaceId, conversationId);
      if (attachments?.length && !hasRole(workspace.role, "member")) {
        throw new AppError({ status: 403, code: "ROLE_INSUFFICIENT", message: "Only a member of this workspace can add files to the brand." });
      }
      // Reconciled first, so a follow-up sent the moment the previous answer arrived carries that
      // answer as context rather than an empty placeholder.
      const current = await reconcile(workspace._id, conversation);
      return ask({ userId, workspace, conversation: current, question, context, attachments });
    },

    /** Removes one of the caller's conversations. The runs behind it stay in the run history. */
    async deleteConversation({ userId, workspaceId, conversationId }) {
      const { workspace } = await requireConversation(userId, workspaceId, conversationId);
      const deleted = await conversationRepository.remove({ workspaceId: workspace._id, conversationId });
      if (!deleted) {
        throw new AppError({ status: 404, code: "CONVERSATION_NOT_FOUND", message: "Conversation was not found." });
      }
      return { deleted: true };
    },
  };
}

/**
 * Reads a finished run into the fields a turn holds.
 *
 * A failure is kept as a failure with its code rather than turned into an apologetic answer: a
 * chat that renders "I could not find that" when the truth is that the index was offline would
 * teach somebody their site does not say something it says.
 */
function answerFrom(run) {
  if (run.status !== "succeeded") {
    return {
      status: run.status,
      error: run.error
        ? { code: run.error.code, message: run.error.message }
        : { code: "RUN_" + String(run.status).toUpperCase(), message: "This question was not answered." },
    };
  }
  const result = run.result ?? {};
  return {
    status: "succeeded",
    text: typeof result.answer === "string" ? result.answer : "",
    citations: Array.isArray(result.citations) ? result.citations.slice(0, 40) : [],
    confidence: typeof result.confidence === "string" ? result.confidence : null,
    searched: Array.isArray(result.searched) ? result.searched.slice(0, 10) : [],
    // A plan of Library changes the agent made none of, waiting for the person to agree to it.
    needsConfirmation: result.needsConfirmation === true,
    // What a brand file offered that the brand chat did not apply, each with why.
    leftOut: Array.isArray(result.leftOut) ? result.leftOut.slice(0, 30).map(leftOutItem).filter(Boolean) : [],
    error: null,
  };
}

/**
 * The context an agent is given: all of it for the brand chat, and without the Brand page's drop
 * section for the Ask agents, which do not take one. Null when nothing is left.
 */
function agentContext(context, brand) {
  if (!context) return null;
  if (brand) return context;
  const rest = Object.fromEntries(Object.entries(context).filter(([key]) => key !== "section"));
  return Object.keys(rest).length ? rest : null;
}

/**
 * One item the brand chat left out, clipped to what a turn stores. A value it could be set to is
 * kept only with the place it would go.
 */
function leftOutItem(item) {
  if (!item || typeof item !== "object" || typeof item.label !== "string") return null;
  const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : null);
  const settable = typeof item.pointer === "string" && item.pointer.startsWith("/") && item.value !== undefined;
  return {
    label: text(item.label, 200),
    reason: text(item.reason, 400) ?? "",
    fileId: typeof item.fileId === "string" && /^[0-9a-f]{24}$/.test(item.fileId) ? item.fileId : null,
    page: Number.isInteger(item.page) ? item.page : null,
    ...(settable ? { pointer: item.pointer.slice(0, 200), value: item.value } : {}),
  };
}

/**
 * The last few turns, as the agent is given them.
 *
 * Trimmed rather than complete: the point is that "and for enterprise?" resolves to a subject, not
 * that the model re-reads the whole thread. A long answer's first paragraph carries its subject.
 */
function contextFrom(conversation) {
  if (!conversation) return [];
  const turns = (conversation.messages ?? [])
    .filter((message) => typeof message.text === "string" && message.text.trim())
    .slice(-CONTEXT_TURNS);
  return turns.map((message, index) => {
    const limit = index === turns.length - 1 && message.role === "assistant"
      ? LATEST_ANSWER_CHARACTERS
      : CONTEXT_CHARACTERS;
    return {
      role: message.role,
      text: message.text.length > limit ? `${message.text.slice(0, limit)}…` : message.text,
    };
  });
}

/**
 * What a conversation is called in the list.
 *
 * The first question, shortened. A model-written title would be better and would cost a second
 * model call before the first answer arrives, which is the wrong trade for a line in a sidebar.
 */
function titleFor(question) {
  const collapsed = question.replace(/\s+/g, " ").trim();
  return collapsed.length > 70 ? `${collapsed.slice(0, 69)}…` : collapsed;
}
