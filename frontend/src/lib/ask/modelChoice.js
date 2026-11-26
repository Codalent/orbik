"use client";

import { useCallback, useState } from "react";

import { useModels } from "@/lib/api/models";

/** Where a person's model choice for Ask is remembered: per person, per workspace, in this browser. */
function choiceKey(userId, workspaceId) {
  return `orbik.ask.model.${userId ?? "anyone"}.${workspaceId}`;
}

/** Reads a remembered tier; storage that cannot be read (private mode, a quota) reads as none. */
function rememberedTier(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Remembers a tier, quietly: a choice that does not survive a reload is not worth an error. */
function rememberTier(key, tier) {
  try {
    window.localStorage.setItem(key, tier);
  } catch {
    // Nothing to do: the choice still holds for this visit.
  }
}

/**
 * The model the Ask panel answers the next question with: a tier of the model catalog, picked in
 * the composer and remembered for this person in this workspace, in this browser.
 *
 * What is remembered is a tier key, never a model, so a tier moved to a newer model in the catalog
 * carries the choice with it. A remembered tier the install's provider does not offer, or nothing
 * remembered, is the default, the most capable. Until the models have loaded there is no choice to
 * show, and `tier` is null: a question sent then carries none, and the API answers it with the
 * default.
 *
 * @param {object} options
 * @param {string} options.workspaceId
 * @param {string|null|undefined} options.userId the signed-in person
 * @returns {{tiers: object[], tier: string|null, setTier: (tier: string) => void}}
 */
export function useAskModel({ workspaceId, userId }) {
  const { models } = useModels();
  const key = choiceKey(userId, workspaceId);
  // The remembered tier is read on the first client render and again when the person or the
  // workspace changes; the panel is drawn in the browser only, so this cannot disagree with markup
  // the server rendered.
  const [stored, setStored] = useState(() => ({ key, tier: typeof window !== "undefined" ? rememberedTier(key) : null }));
  if (stored.key !== key) setStored({ key, tier: typeof window !== "undefined" ? rememberedTier(key) : null });

  const tiers = models?.tiers ?? [];
  const offered = tiers.some((entry) => entry.tier === stored.tier);
  const tier = models ? (offered ? stored.tier : models.defaultTier ?? tiers[0]?.tier ?? null) : null;

  const setTier = useCallback((next) => {
    setStored({ key, tier: next });
    rememberTier(key, next);
  }, [key]);

  return { tiers, tier, setTier };
}
