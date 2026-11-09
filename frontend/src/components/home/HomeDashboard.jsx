"use client";

import { useState } from "react";
import useSWR from "swr";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { HomeHeader } from "./HomeHeader";
import { HomeSkeleton } from "./HomeSkeleton";
import { SetupChecklist } from "./SetupChecklist";
import { WorkspaceGlance } from "./WorkspaceGlance";
import { requestCrawl } from "@/lib/api/crawl";
import { homePath, updateHomePreferences } from "@/lib/api/home";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useCrawlOverview } from "@/lib/crawl/useCrawlOverview";

/** How often Home is read again while a step is moving — a crawl, a write, a first call — and otherwise. */
const LIVE_MS = 5000;
const IDLE_MS = 60_000;

/**
 * The Home page: the setup checklist first, then the workspace at a glance.
 *
 * One read (`GET …/home`) carries both, polled every five seconds while any step is in progress
 * and every minute otherwise, so a crawl's counts move and a step turns done without a reload. It
 * is also re-read when the tab is looked at again, which is how a token minted on Settings in
 * another tab, or a structure chosen in the Library, shows up here.
 *
 * With every essential done the glance leads and the checklist follows it as one line; a person
 * who hid the checklist sees only the glance, with a way to bring it back.
 *
 * @param {object} props
 * @param {string} props.workspaceId
 */
export function HomeDashboard({ workspaceId }) {
  const auth = useAuth();
  const read = useSWR(homePath(workspaceId), {
    refreshInterval: (latest) => (latest?.live ? LIVE_MS : IDLE_MS),
  });
  // The sidebar's crawl status, from the same cache: asking for a crawl here re-reads it too.
  const crawl = useCrawlOverview(workspaceId);
  const [failure, setFailure] = useState(null);
  const home = read.data ?? null;
  const myEmail = auth.user?.email ?? null;

  async function savePreferences(change) {
    setFailure(null);
    try {
      const { preferences } = await updateHomePreferences(workspaceId, change);
      // Merged at once, then read again: the steps a skip changes are worked out by the server.
      await read.mutate((current) => (current ? { ...current, preferences } : current), { revalidate: true });
    } catch (error) {
      setFailure(error?.message ?? "That could not be saved. Try again.");
    }
  }

  async function retryCrawl() {
    setFailure(null);
    try {
      await requestCrawl(workspaceId);
      await Promise.all([read.mutate(), crawl.refresh()]);
    } catch (error) {
      setFailure(error?.message ?? "The crawl could not be asked for. Try again.");
    }
  }

  const refresh = () => { read.mutate().catch(() => {}); };

  if (!home) {
    return read.error
      ? <div className="p-6"><Alert variant="destructive" role="alert"><AlertDescription>Home could not be loaded. Refresh to try again.</AlertDescription></Alert></div>
      : <HomeSkeleton />;
  }

  const complete = home.progress.essentials.done === home.progress.essentials.total;
  const hidden = home.preferences.hidden;
  const checklist = hidden ? null : (
    <SetupChecklist
      // Keyed by the workspace so switching resets what was opened.
      key={workspaceId}
      home={home}
      myEmail={myEmail}
      onPreferences={savePreferences}
      onRetryCrawl={retryCrawl}
      onChanged={refresh}
    />
  );
  const glance = <WorkspaceGlance home={home} myEmail={myEmail} />;

  return (
    <main aria-labelledby="home-title" className="mx-auto w-full max-w-6xl min-w-0 space-y-6 px-4 pb-14 pt-6 md:px-8 md:pt-8">
      <HomeHeader home={home} hidden={hidden} onShowSetup={() => savePreferences({ hidden: false })} />

      {failure && <Alert variant="destructive" role="alert"><AlertDescription>{failure}</AlertDescription></Alert>}

      {complete ? <>{glance}{checklist}</> : <>{checklist}{glance}</>}
    </main>
  );
}
