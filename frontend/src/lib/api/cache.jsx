"use client";

import { useCallback, useEffect } from "react";
import { SWRConfig, useSWRConfig } from "swr";

import { apiFetch, subscribeAccessChange, subscribeSession } from "./client";
import { WORKSPACES_PATH } from "./workspaces";

/** How many times a failed read is retried before it is left to the next focus or poll. */
const MAX_RETRIES = 3;

/**
 * Retries a failed read only when trying again could help.
 *
 * A 4xx is the server's answer rather than a fault: a missing page stays missing, and a signed-out
 * session is already being handled by the API client. Retrying those would repeat a request whose
 * reply is known, on a backoff nobody is waiting for.
 */
function onErrorRetry(error, _key, config, revalidate, { retryCount }) {
  if (error?.status >= 400 && error.status < 500 && error.status !== 429) return;
  if (retryCount >= MAX_RETRIES) return;
  setTimeout(() => revalidate({ retryCount }), config.errorRetryInterval * 2 ** retryCount);
}

/**
 * The one cache of what the API said, shared by every component that reads it.
 *
 * A read is keyed by its API path and fetched by `apiFetch`, so two components asking for the same
 * thing make one request and can never disagree about the answer. It is re-read when the tab is
 * looked at again and when the network returns, which is what used to take a manual reload.
 *
 * The key convention is the path itself — `/v1/workspaces/<id>/…` — so everything belonging to a
 * workspace can be re-read at once by its prefix; see `useRevalidateWorkspace`.
 */
export function ApiCacheProvider({ children }) {
  return (
    <SWRConfig value={{ fetcher: apiFetch, onErrorRetry }}>
      <SessionCacheReset />
      <AccessChangeReread />
      {children}
    </SWRConfig>
  );
}

/**
 * Empties the cache when the session ends.
 *
 * The cache outlives the components that filled it, so without this the next person to sign in on
 * the same tab would be shown the previous account's data for the moment before each read returns.
 */
function SessionCacheReset() {
  const { mutate } = useSWRConfig();
  useEffect(() => subscribeSession((session) => {
    if (!session) mutate(() => true, undefined, { revalidate: false });
  }), [mutate]);
  return null;
}

/**
 * Re-reads the workspace list when a request is refused because the person's access changed — they
 * were removed from a workspace, or their role in it was lowered. The list carries each role, so
 * the controls a role may not use disappear, and a workspace that is gone drops out of it, which
 * the workspace gate answers by moving to the next one.
 */
function AccessChangeReread() {
  const { mutate } = useSWRConfig();
  useEffect(() => subscribeAccessChange(() => {
    mutate(WORKSPACES_PATH);
  }), [mutate]);
  return null;
}

/**
 * Returns a function that re-reads everything cached for one workspace.
 *
 * For changes whose reach is wider than the component that made them: saving crawl settings or
 * clearing crawl data alters what the sidebar, the Library and every agent page would be told, and
 * naming each of those reads at the call site is how one of them gets forgotten.
 *
 * @param {string} workspaceId
 * @returns {() => Promise<unknown>}
 */
export function useRevalidateWorkspace(workspaceId) {
  const { mutate } = useSWRConfig();
  return useCallback(() => {
    const prefix = `/v1/workspaces/${workspaceId}/`;
    // A paged list (`useSWRInfinite`) is cached under its first
    // page's key with `$inf$` in front; matching that too re-reads it with everything else.
    return mutate((key) => typeof key === "string" && (key.startsWith(prefix) || key.startsWith(`$inf$${prefix}`)));
  }, [mutate, workspaceId]);
}
