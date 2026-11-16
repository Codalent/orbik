"use client";

import { useEdition } from "@/lib/api/edition";
import { useAuth } from "@/lib/auth/AuthProvider";

/**
 * Whether this install can make AI calls, and how to say so when it cannot.
 *
 * `GET /v1/edition` may carry `ai: {reasoning, search}`: whether the reasoning provider's key and
 * the embedding key are configured. Either may be missing — an older API, or a worker that has not
 * recorded it yet — and a missing answer is read as available, so nothing is refused on a guess;
 * only an explicit `false` says AI is unavailable.
 *
 * How it is said depends on who reads it. The install's admin can change the setting, so they get
 * the technical reason and the setting to change; everybody else gets one plain sentence with no variable
 * names or error codes, because there is nothing in it they can act on.
 */

/** The error codes a run or a step records when no reasoning provider is configured. */
export const AI_UNAVAILABLE_CODES = Object.freeze(["NO_ROUTE", "PROVIDER_NOT_CONFIGURED"]);

/** Whether an error, as the API records it on a run or a turn, means AI is not configured. */
export function isAiUnavailableError(error) {
  return Boolean(error?.code) && AI_UNAVAILABLE_CODES.includes(error.code);
}

/**
 * What this install says about AI, and whether the signed-in person is its admin.
 *
 * @returns {{reasoning: boolean, search: boolean, isAdmin: boolean}} `reasoning` and `search` are
 *   false only when the API says so
 */
export function useAiAvailability() {
  const { edition } = useEdition();
  const auth = useAuth();
  return {
    reasoning: edition?.ai?.reasoning !== false,
    search: edition?.ai?.search !== false,
    isAdmin: Boolean(auth.user?.isAdmin),
  };
}

/**
 * The sentence that says AI is unavailable and what follows from it.
 *
 * @param {string} consequence what cannot happen, as a clause: "Ask cannot answer questions"
 * @param {object} options
 * @param {boolean} options.isAdmin whether the reader is the install's admin
 * @param {"reasoning"|"search"} [options.kind] which key is missing
 */
export function aiUnavailableText(consequence, { isAdmin, kind = "reasoning" }) {
  if (!isAdmin) return `AI is not available on this Orbik right now, so ${consequence}.`;
  // The install's configuration is the Docker install's `.env`, or `backend/.env` and
  // `agents/.env` without Docker (docs/self-hosting/configuration.md); both read these names.
  if (kind === "search") {
    return `No embedding key is configured, so ${consequence}. Set ORBIK_OPENAI_API_KEY in the install's configuration and restart it.`;
  }
  return `No AI provider is configured for reasoning work, so ${consequence}. Set ORBIK_OPENAI_API_KEY or ORBIK_ANTHROPIC_API_KEY in the install's configuration (ORBIK_AI_PROVIDER chooses when both are set) and restart it.`;
}
