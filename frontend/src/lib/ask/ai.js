"use client";

import {
  aiUnavailableText as unavailableSentence,
  isAiUnavailable,
  useAiAvailability as useAgentsAiAvailability,
} from "@/lib/agents/aiAvailability";

/**
 * Whether this install can make AI calls, and how Ask and Home say so when it cannot.
 *
 * A thin reading of `lib/agents/aiAvailability.js`, which every page uses, so Ask and Home say it
 * in the same words as the agents' pages: plainly for everyone ("AI is not available on this Orbik
 * right now, so …"), with the reason and the setting for the install's admin. Only an explicit
 * `ai.reasoning: false` from `GET /v1/edition` means unavailable; a missing answer is read as
 * available, so nothing is refused on a guess.
 */

/** Whether an error, as the API records it on a run or a turn, means AI is not configured. */
export function isAiUnavailableError(error) {
  return isAiUnavailable(error);
}

/**
 * What this install says about AI, and whether the signed-in person is its admin.
 *
 * @returns {{reasoning: boolean, isAdmin: boolean}} `reasoning` is false only when the API says so
 */
export function useAiAvailability() {
  const { reasoningOff, isAdmin } = useAgentsAiAvailability();
  return { reasoning: !reasoningOff, isAdmin };
}

/**
 * The sentence that says AI is unavailable and what follows from it.
 *
 * @param {string} consequence what cannot happen, as a clause: "Ask cannot answer questions"
 * @param {object} options
 * @param {boolean} options.isAdmin whether the reader is the install's admin
 * @param {string|null} [options.reason] the recorded reason, which an admin is shown
 */
export function aiUnavailableText(consequence, { isAdmin, reason = null }) {
  return unavailableSentence({ isAdmin, consequence, reason });
}
