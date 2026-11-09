"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

import * as brandApi from "@/lib/api/brand";
import { pinAt, readPointer } from "@/lib/brand/brand";

const BrandContext = createContext(null);

/**
 * What every section of the Brand page shares: the system on screen, and the two ways it is
 * corrected.
 *
 * A correction is always the same act, wherever on the page it is made: pin a value at a place in
 * the system, or unpin it. Putting that here means a swatch, a row of the type scale and a line of
 * the image prompt are corrected by one piece of code, and the answer the API gives back — the
 * system with the pin applied — replaces what every section is showing at once.
 *
 * @param {object} props
 * @param {string} props.workspaceId
 * @param {object} props.brand the system view from the API: `system`, `proposal`, `pins`
 * @param {object[]} props.assets the workspace's stored images
 * @param {object|null} props.observation the pages the system was read from
 * @param {(update: (current: object) => object) => void} props.onChange folds an API answer into
 *   the cached read
 * @param {boolean} [props.canEdit] whether the person's role may correct the system; without it
 *   every section draws its values and none of the ways to change them
 */
export function BrandProvider({ workspaceId, brand, assets, observation, onChange, canEdit = true, children }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  /** Runs one correction, keeping the page honest about whether it is in flight or failed. */
  const act = useCallback(async (work) => {
    setBusy(true);
    setError(null);
    try {
      return await work();
    } catch (failure) {
      setError(failure?.fields?.[0]?.message ?? failure?.message ?? "That could not be saved. Try again.");
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const pin = useCallback(async (pointer, value) => {
    const response = await act(() => brandApi.setBrandPin(workspaceId, pointer, value));
    if (response?.brand) onChange((current) => ({ ...current, brand: response.brand }));
    return Boolean(response);
  }, [act, onChange, workspaceId]);

  const unpin = useCallback(async (pointer) => {
    const response = await act(() => brandApi.removeBrandPin(workspaceId, pointer));
    if (response?.brand) onChange((current) => ({ ...current, brand: response.brand }));
    return Boolean(response);
  }, [act, onChange, workspaceId]);

  const updateAsset = useCallback(async (assetId, changes) => {
    const response = await act(() => brandApi.updateBrandAsset(workspaceId, assetId, changes));
    if (response?.asset) {
      onChange((current) => ({ ...current, assets: current.assets.map((asset) => (asset.id === response.asset.id ? response.asset : asset)) }));
    }
    return Boolean(response);
  }, [act, onChange, workspaceId]);

  const value = useMemo(() => ({
    workspaceId,
    canEdit,
    system: brand?.system ?? null,
    proposal: brand?.proposal ?? null,
    pins: brand?.pins ?? [],
    assets,
    observation,
    busy,
    error,
    pin,
    unpin,
    updateAsset,
    /** The pin at one place, or null. */
    pinAt: (pointer) => pinAt(brand?.pins, pointer),
    /** What the agent proposed at one place, whatever is pinned there. */
    proposedAt: (pointer) => readPointer(brand?.proposal, pointer),
  }), [assets, brand, busy, canEdit, error, observation, pin, unpin, updateAsset, workspaceId]);

  return <BrandContext.Provider value={value}>{children}</BrandContext.Provider>;
}

/** The brand on screen and how to correct it. */
export function useBrand() {
  const value = useContext(BrandContext);
  if (!value) throw new Error("useBrand must be used inside a BrandProvider.");
  return value;
}
