"use client";

import { useCallback } from "react";
import useSWR from "swr";

import { crawlOverviewPath } from "@/lib/api/crawl";

/** How often crawl status is re-read while a crawl is running or waiting to start. */
const LIVE_MS = 4000;

/** How often it is re-read otherwise, which is how a crawl the scheduler started gets noticed. */
const IDLE_MS = 30_000;

/**
 * Reads one workspace's crawl status, shared by everything that displays it.
 *
 * The sidebar and the crawl page both show the same thing — is a crawl running, and what did the
 * last one find. Both call this, and because the read is cached by its path they make one request
 * between them and can never disagree. It keeps reading at a slow cadence while nothing is
 * running: the scheduler starts crawls on its own, and a page that only polled once it already
 * knew a crawl was live would never find out about one it did not start.
 *
 * @param {string|null} workspaceId null reads nothing, for a shell with no workspace selected yet
 * @returns {{crawl: object|null, failed: boolean, refresh: () => Promise<void>}}
 */
export function useCrawlOverview(workspaceId) {
  const { data, error, mutate } = useSWR(workspaceId ? crawlOverviewPath(workspaceId) : null, {
    refreshInterval: (latest) => (latest?.activeRun || latest?.queued ? LIVE_MS : IDLE_MS),
  });

  /** Re-reads crawl status after something changes it, such as asking for a crawl. */
  const refresh = useCallback(async () => {
    try {
      await mutate();
    } catch {
      // Leaving the previous status in place is better than blanking it: the change that
      // prompted the refresh still happened, and the next poll will correct it.
    }
  }, [mutate]);

  // "Not loaded yet" and "could not be read" are both an absent status, so the failure is
  // reported separately: without it a page waiting for status and a page that will never get it
  // look identical, and one of them would show a skeleton forever.
  return { crawl: data ?? null, failed: Boolean(error) && !data, refresh };
}
