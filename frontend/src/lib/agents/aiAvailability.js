"use client";

import { useCallback } from "react";

import { useEdition } from "@/lib/api/edition";
import { useAuth } from "@/lib/auth/AuthProvider";

/**
 * How a page says that AI is not available, the same way everywhere.
 *
 * An install admin (`user.isAdmin`) is told the technical reason and the setting to change; anyone
 * else is told, without a setting's name or an error code, "AI is not available on this Orbik right
 * now, so <what that means here>." Whether AI is available at all is `ai.reasoning` in
 * `GET /v1/edition`, which the agents worker recorded at its start; a page asks before a person
 * presses Run, and a run that failed for it anyway is described with the same words.
 */

/** The failure codes that mean the reasoning provider is missing or its key was refused. */
const AI_UNAVAILABLE_CODES = new Set(["NO_ROUTE", "PROVIDER_NOT_CONFIGURED"]);

/** What an admin is told to change. Install settings, so words for the person who runs the install. */
export const AI_SETTING_HINT = "Set ORBIK_ANTHROPIC_API_KEY or ORBIK_OPENAI_API_KEY in the agents worker's environment (agents/.env; ORBIK_AI_PROVIDER chooses when both are set), then restart the worker and the scheduler.";

/** What an admin is told when no reason was recorded. */
const DEFAULT_REASON = "No AI provider is configured for reasoning work.";

/** Whether a failure (a run's `error`, a skipped step's `reason`) is AI being unavailable. */
export function isAiUnavailable(failure) {
  return Boolean(failure && AI_UNAVAILABLE_CODES.has(failure.code));
}

/** Whether the edition says no reasoning provider is configured; false while it is unknown. */
export function reasoningUnavailable(edition) {
  return edition?.ai?.reasoning === false;
}

/**
 * The sentence for AI being unavailable.
 *
 * @param {object} options
 * @param {boolean} options.isAdmin whether the reader administers the install
 * @param {string} options.consequence what it means here, to follow "so": "the file cannot be written"
 * @param {string|null} [options.reason] the recorded reason, for an admin
 */
export function aiUnavailableText({ isAdmin, consequence, reason = null }) {
  if (isAdmin) {
    const said = (reason || DEFAULT_REASON).trim().replace(/\.$/, "");
    return `${said}, so ${consequence}. ${AI_SETTING_HINT}`;
  }
  return `AI is not available on this Orbik right now, so ${consequence}.`;
}

/**
 * A run's failure (or a skipped step's reason) as a person reads it: AI being unavailable in the
 * words above, a plan limit as the sentence the limit gave, anything else as its message. Never a
 * bare code.
 *
 * @param {{code?: string, message?: string}|null} failure
 * @param {object} options
 * @param {boolean} options.isAdmin
 * @param {string} options.consequence what AI being unavailable meant for this run
 */
export function describeFailure(failure, { isAdmin, consequence }) {
  if (!failure) return null;
  if (isAiUnavailable(failure)) return aiUnavailableText({ isAdmin, consequence, reason: failure.message });
  if (failure.code === "PLAN_LIMIT_REACHED") return planLimitText(failure.message);
  return sentence(failure.message) ?? "The run failed.";
}

/**
 * A plan limit's refusal. The extension that set the limit words it ("This workspace's plan does
 * not include this agent."); a message that is missing, or only a code, is replaced by a sentence
 * that names no plan.
 */
export function planLimitText(message) {
  const said = sentence(message);
  if (said && !/^[A-Z0-9_]+\.?$/.test(message.trim())) return said;
  return "This workspace's plan does not allow this, so it was not done.";
}

/** Text with its first letter in capitals and a full stop, or null when there is none. */
function sentence(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) return null;
  const capital = trimmed[0].toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/**
 * The page's side of it: whether reasoning is known to be unavailable, whether the reader is an
 * admin, and the two helpers bound to that reader.
 *
 * @returns {{reasoningOff: boolean, isAdmin: boolean, unavailable: (consequence: string) => string, failure: (failure: object|null, consequence: string) => string|null}}
 */
export function useAiAvailability() {
  const { edition } = useEdition();
  const { user } = useAuth();
  const isAdmin = Boolean(user?.isAdmin);
  const unavailable = useCallback((consequence) => aiUnavailableText({ isAdmin, consequence }), [isAdmin]);
  const failure = useCallback((entry, consequence) => describeFailure(entry, { isAdmin, consequence }), [isAdmin]);
  return { reasoningOff: reasoningUnavailable(edition), isAdmin, unavailable, failure };
}
