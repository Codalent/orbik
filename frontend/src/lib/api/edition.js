"use client";

import useSWR from "swr";

/** What this install is: edition, release, features, signup, and whether it needs setting up. */
export const EDITION_PATH = "/v1/edition";

/**
 * Reads the edition once per page load and keeps it: it changes only when the install is
 * reconfigured or claimed, and the setup page re-reads it when it claims one.
 *
 * @returns {{edition: {edition: string, version: string, features: string[], signup: "open"|"closed", setupRequired: boolean}|undefined, error: unknown, mutate: Function}}
 */
export function useEdition() {
  const { data, error, mutate } = useSWR(EDITION_PATH, {
    revalidateOnFocus: false,
    revalidateIfStale: false,
    dedupingInterval: 60_000,
  });
  return { edition: data, error, mutate };
}

/** Whether a slot that names `feature` may show: one naming none always may. */
export function featureEnabled(edition, feature) {
  if (!feature) return true;
  return Boolean(edition?.features?.includes(feature));
}
