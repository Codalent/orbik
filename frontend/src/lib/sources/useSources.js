"use client";

import { useEffect, useRef } from "react";
import useSWR, { useSWRConfig } from "swr";

import { LIVE_ACTIVITY_PATH } from "@/lib/api/activity";
import { sourcePath, sourcesPath } from "@/lib/api/sources";
import { isLive } from "./sources";

/** How often the sources are read while one is being read, and otherwise. */
const LIVE_MS = 4000;
const IDLE_MS = 30_000;

/**
 * A workspace's sources, re-read every few seconds while one of them is being read.
 *
 * The sidebar and the pages read the same key, so they never disagree. When a source starts or
 * stops being read, the activity monitor is told to look again at once, as the crawl page does.
 */
export function useSources(workspaceId) {
  const { mutate: mutateCache } = useSWRConfig();
  const { data, error, mutate } = useSWR(workspaceId ? sourcesPath(workspaceId) : null, {
    refreshInterval: (latest) => (latest?.sources?.some(isLive) ? LIVE_MS : IDLE_MS),
  });
  const live = Boolean(data?.sources?.some(isLive));
  const was = useRef(live);
  useEffect(() => {
    if (was.current !== live) mutateCache(LIVE_ACTIVITY_PATH);
    was.current = live;
  }, [live, mutateCache]);
  return { data: data ?? null, failed: Boolean(error) && !data, error, refresh: mutate };
}

/** One source in full, re-read every few seconds while it is being read. */
export function useSource(workspaceId, sourceId) {
  const { data, error, mutate } = useSWR(workspaceId && sourceId ? sourcePath(workspaceId, sourceId) : null, {
    refreshInterval: (latest) => (isLive(latest?.source) ? LIVE_MS : IDLE_MS),
  });
  return { data: data ?? null, failed: Boolean(error) && !data, error, refresh: mutate };
}
