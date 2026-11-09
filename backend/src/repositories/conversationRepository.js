import { toObjectId } from "@orbik/core";
import { ObjectId } from "mongodb";

/**
 * Storage for the questions a workspace has asked its index, and the answers.
 *
 * A conversation is one document with its turns inside it, rather than a collection of messages
 * keyed by conversation. That is the right shape here for one reason: a conversation is never read
 * partially. The page shows the whole thread, the next question is answered with the last few
 * turns as context, and a thread is bounded — a person asking a hundred questions in one sitting
 * starts a new one long before the document is large. The usual argument for a separate messages
 * collection, that a thread grows without limit, is met by the bound instead.
 *
 * Every query is keyed on the workspace as well as on the conversation. A conversation identifier
 * is not an authorization token: reaching one through its workspace means somebody guessing
 * another account's identifier is refused by the same check that protects the workspace.
 */

/** Turns kept on one conversation. Beyond this it is a new conversation, not a longer one. */
const MAX_MESSAGES = 200;

/**
 * @param {object} collections agent-owned collection handles from `getAgentCollections`
 */
export function createConversationRepository(collections) {
  const { conversations } = collections;

  return {
    /**
     * One person's conversations in a workspace, most recently used first, without their turns.
     *
     * `includeUnattributed` adds rows that record nobody, which predate members and are the
     * owner's; only the owner's list asks for them.
     */
    async list({ workspaceId, userId, includeUnattributed = false, limit = 50 }) {
      const person = toObjectId(userId);
      const filter = includeUnattributed
        ? { workspaceId, $or: [{ userId: person }, { userId: null }] }
        : { workspaceId, userId: person };
      return conversations
        .find(filter)
        .project({ title: 1, createdAt: 1, updatedAt: 1, messages: { $slice: -1 } })
        .sort({ updatedAt: -1 })
        .limit(limit)
        .toArray();
    },

    /** One conversation, or null when it is not this workspace's. */
    async find({ workspaceId, conversationId }) {
      if (!ObjectId.isValid(conversationId)) return null;
      return conversations.findOne({ workspaceId, _id: new ObjectId(conversationId) });
    },

    /** Starts a conversation with its first question. */
    async create({ workspaceId, userId, title, messages, at }) {
      const document = {
        workspaceId,
        userId,
        title,
        messages,
        createdAt: at,
        updatedAt: at,
      };
      const { insertedId } = await conversations.insertOne(document);
      return { ...document, _id: insertedId };
    },

    /**
     * Appends turns to a conversation.
     *
     * `$slice` on the push keeps the newest turns and drops the oldest, so a thread somebody never
     * closes stays a bounded document rather than growing until a read of it is expensive.
     */
    async append({ workspaceId, conversationId, messages, at }) {
      return conversations.findOneAndUpdate(
        { workspaceId, _id: new ObjectId(conversationId) },
        {
          $push: { messages: { $each: messages, $slice: -MAX_MESSAGES } },
          $set: { updatedAt: at },
        },
        { returnDocument: "after" },
      );
    },

    /**
     * Replaces one turn in place, by its identifier.
     *
     * Used when a run finishes and the answer it produced is folded into the message that was
     * waiting for it. Addressed by the message's own id rather than by its position, because a
     * position is not stable under the `$slice` above.
     */
    async replaceMessage({ workspaceId, conversationId, messageId, message }) {
      return conversations.findOneAndUpdate(
        { workspaceId, _id: new ObjectId(conversationId), "messages.id": messageId },
        { $set: { "messages.$": message } },
        { returnDocument: "after" },
      );
    },

    /** Removes a conversation for good. */
    async remove({ workspaceId, conversationId }) {
      if (!ObjectId.isValid(conversationId)) return false;
      const result = await conversations.deleteOne({ workspaceId, _id: new ObjectId(conversationId) });
      return result.deletedCount === 1;
    },
  };
}

/**
 * One conversation as the interface reads it.
 *
 * @param {object} conversation a stored conversation
 */
export function toConversation(conversation) {
  return {
    id: conversation._id.toHexString(),
    title: conversation.title,
    createdAt: toIso(conversation.createdAt),
    updatedAt: toIso(conversation.updatedAt),
    messages: (conversation.messages ?? []).map(toMessage),
  };
}

/** One conversation in a list: enough to choose between threads, without their contents. */
export function toConversationSummary(conversation) {
  const last = (conversation.messages ?? []).at(-1);
  return {
    id: conversation._id.toHexString(),
    title: conversation.title,
    createdAt: toIso(conversation.createdAt),
    updatedAt: toIso(conversation.updatedAt),
    lastMessage: last ? toMessage(last) : null,
  };
}

/** One turn. */
function toMessage(message) {
  return {
    id: message.id,
    role: message.role,
    text: message.text ?? null,
    citations: message.citations ?? [],
    confidence: message.confidence ?? null,
    searched: message.searched ?? [],
    // What the run behind this answer changed in the Library, as its own events recorded it.
    changes: message.changes ?? [],
    // What the run behind this answer changed in the brand, each with before, after and an undo.
    brandChanges: message.brandChanges ?? [],
    // What a brand file offered that the chat did not apply, and why.
    leftOut: message.leftOut ?? [],
    // Files the person sent with this turn: what each is, for the chip beside the question.
    attachments: message.attachments ?? [],
    needsConfirmation: message.needsConfirmation === true,
    // Where the person was when they asked, so the thread can show it beside the question.
    context: message.context ?? null,
    runId: message.runId ? String(message.runId) : null,
    status: message.status ?? null,
    error: message.error ?? null,
    at: toIso(message.at),
  };
}

/** Formats a stored instant, tolerating one that was never written. */
function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}
