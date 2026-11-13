"use client";

import { Suspense, useState } from "react";
import { House, MessagesSquare, Search, Settings } from "lucide-react";
import { useParams, usePathname, useRouter } from "next/navigation";
import useSWR from "swr";

import { AskPanel } from "@/components/ask/AskPanel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ASK_SHORTCUT, AskPanelProvider, useAskPanel } from "@/lib/ask/askPanel";
import { OrbikLogo } from "@/components/OrbikLogo";
import { NeutralLoading } from "@/components/NeutralLoading";
import { buildAgentRows } from "@/lib/agents/registry";
import { LIVE_ACTIVITY_PATH } from "@/lib/api/activity";
import { WORKSPACES_PATH, selectWorkspace } from "@/lib/api/workspaces";
import { useCrawlOverview } from "@/lib/crawl/useCrawlOverview";
import { extensionApi, useExtensionSlots } from "@/lib/extensions/slots";
import { buildKnowledgeRows } from "@/lib/library/registry";
import { LIBRARY_SWITCHER_EVENT } from "@/lib/library/workspaceTabs";
import { useAuth } from "@/lib/auth/AuthProvider";
import { ProtectedRoute } from "@/lib/auth/ProtectedRoute";
import { AppSidebar } from "./AppSidebar";
import { ThemeSwitch } from "./ThemeSwitch";
import { UserMenu } from "./UserMenu";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { cn } from "@/lib/utils";
import { SectionRail, buildRail } from "./SectionRail";
import { workspaceHomePagePath, workspaceHomePath } from "@/lib/workspaces/home";

/**
 * Loads the private owner-scoped sidebar before rendering workspace content.
 *
 * The Ask panel's state is provided here, around everything, so any page can open it and it stays
 * open — with its conversation — as the person moves between pages.
 */
export function WorkspaceShell({ children }) {
  return (
    <AskPanelProvider>
      <WorkspaceChrome>{children}</WorkspaceChrome>
    </AskPanelProvider>
  );
}

/** The header, the rail, the page, and the Ask panel beside it. */
function WorkspaceChrome({ children }) {
  const auth = useAuth();
  const ask = useAskPanel();
  const params = useParams();
  const router = useRouter();
  const pathname = usePathname();
  const { data, error: listError, mutate: mutateWorkspaces } = useSWR(WORKSPACES_PATH);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const selectedWorkspaceId = data?.selectedWorkspaceId ?? null;

  // The sidebar shows what each agent is doing, so it needs the workspace's crawl status. The
  // crawl page reads the same thing through the same hook, and the cache behind it is what keeps
  // the two from disagreeing. A failed read leaves it null, which the row renders as "status
  // unavailable" rather than guessing that nothing is happening.
  const { crawl } = useCrawlOverview(selectedWorkspaceId);

  // What the rail says about the Library being written comes from the same read the activity
  // monitor at the sidebar's foot polls, from the same cache: this asks for nothing of its own and
  // is re-rendered whenever that poll brings something new.
  const { data: activity = null } = useSWR(LIVE_ACTIVITY_PATH);
  // What an installed extension adds: rail items, banners and agents. Empty in the open-source edition.
  const extensionSlots = useExtensionSlots();

  const knowledge = selectedWorkspaceId ? buildKnowledgeRows(selectedWorkspaceId, activity) : [];
  const agents = selectedWorkspaceId ? buildAgentRows(selectedWorkspaceId, crawl, extensionSlots.agentPages) : [];
  // Settings is in the rail because connecting an AI is something a person looks for from
  // wherever they are; it sits at the bottom of it, apart from the places a person works in.
  const settingsLink = selectedWorkspaceId ? [{ id: "settings", name: "Settings", icon: Settings, href: `/workspaces/${selectedWorkspaceId}/settings` }] : [];
  // An extension's rail items sit after the gap below the agents.
  const extensionLinks = selectedWorkspaceId
    ? extensionSlots.railItems.map((item) => ({ id: `extension-${item.id}`, name: item.name, icon: item.icon, href: `/workspaces/${selectedWorkspaceId}/${item.path}` }))
    : [];
  // Home first: where somebody new to a workspace is sent, and the workspace at a glance after.
  const homeLink = selectedWorkspaceId ? [{ id: "home", name: "Home", icon: House, href: workspaceHomePagePath(selectedWorkspaceId) }] : [];
  // The overview of every agent: where the rail's Agents item leads, and the first row of the
  // agents' sidebar.
  const agentsHref = selectedWorkspaceId ? `/workspaces/${selectedWorkspaceId}/agents` : null;
  const built = buildRail({ leading: homeLink, knowledge, agents, links: extensionLinks, footer: settingsLink, agentsHref, path: pathname });
  // Ask is not a page any more but the panel at the right, so its rail item opens and closes it
  // and is drawn as current while it is open.
  const rail = {
    ...built,
    items: built.items.map((item) => (item.id === "ask" ? { ...item, onSelect: ask.toggle, active: ask.open } : item)),
  };

  // The workspace the panel answers for is the one in the address, which is the page on screen;
  // the selected one stands in on the rare page under the shell that has none.
  const panelWorkspaceId = typeof params?.workspaceId === "string" ? params.workspaceId : selectedWorkspaceId;
  // What the page on screen is called, as the rail or the sidebar names it, so the panel can tell
  // the agent where the person is.
  const overviewLink = agentsHref ? [{ name: "Agents", href: agentsHref }] : [];
  const pageName = pageNameFor(pathname, [...homeLink, ...knowledge, ...overviewLink, ...agents, ...extensionLinks, ...settingsLink], panelWorkspaceId);
  // On the Library — at its own address or the agent's that renders it — the header carries the
  // way into its quick switcher, which the page opens when asked; the shell holds none of its state.
  const onLibrary = /^\/workspaces\/[^/]+\/(?:library|agents\/business-knowledge-base)\/?$/.test(pathname ?? "");

  /** Selects only an identifier supplied by the owner-scoped server list. */
  async function select(id) {
    setBusy(true);
    setError(null);
    try {
      const result = await selectWorkspace(id);
      await mutateWorkspaces(
        (current) => (current ? { ...current, selectedWorkspaceId: result.selectedWorkspaceId } : current),
        { revalidate: false },
      );
      router.replace(workspaceHomePath(id));
    } catch {
      setError("That workspace is no longer available. Choose another workspace.");
    } finally { setBusy(false); }
  }

  /** Clears server and in-memory session state before leaving the private shell. */
  async function signOut() {
    setBusy(true);
    await auth.signOut();
    router.replace("/login");
  }

  return (
    <ProtectedRoute>
      {!data ? (
        // A list that could not be read is said out loud. It used to leave the skeleton up for
        // good, which looks exactly like a slow connection and never resolves.
        listError
          ? <main className="flex min-h-screen items-center justify-center p-6"><Alert variant="destructive" role="alert" className="w-auto"><AlertDescription>Workspaces could not be loaded. Refresh to try again.</AlertDescription></Alert></main>
          : <NeutralLoading />
      ) : (
        // From `md` up the chrome is pinned to the viewport and only the content panel scrolls, so
        // the rail and the sidebar are always reachable however long a page gets. Below `md` they
        // stack above the content and the page scrolls normally; pinning there would leave the
        // content a sliver of an already short screen.
        //
        // The chrome is a flat colour and covers the dot field the rest of the product floats on:
        // in margins this narrow the dots are noise around the rail's labels, not a backdrop.
        <div className="flex min-h-screen flex-col bg-orb-black md:h-screen md:min-h-0 md:overflow-hidden">
          {/* The workspace sits beside the mark because it is what everything below belongs to:
              the rail, the sidebar and the page all change with it. */}
          <header className="flex h-11 shrink-0 items-center gap-2 px-4">
            <OrbikLogo className="h-[18px] w-auto shrink-0 text-orb-lime" />
            <span aria-hidden="true" className="ml-1 h-4 w-px bg-orb-line" />
            <div className="min-w-0 max-w-64">
              <WorkspaceSwitcher workspaces={data.items} selectedWorkspaceId={data.selectedWorkspaceId} onSelect={select} disabled={busy} />
            </div>
            <div className="ml-auto flex items-center gap-2">
              {onLibrary && (
                <button
                  type="button"
                  onClick={() => window.dispatchEvent(new Event(LIBRARY_SWITCHER_EVENT))}
                  className="hidden h-8 items-center gap-2 rounded-[13px] border border-orb-line px-2.5 text-compact text-orb-muted transition-colors hover:border-orb-muted hover:text-orb-white sm:flex"
                >
                  <Search aria-hidden="true" className="size-3.5" />
                  <span>Search or jump to…</span>
                  <kbd className="rounded-[5px] border border-orb-line px-1.5 font-sans text-2xs">⌘O</kbd>
                </button>
              )}
              {/* Ask opens from here as well as the rail, with its shortcut beside it, because it is
                  the one thing in the product meant to be reached from every page. */}
              {selectedWorkspaceId && (
                <button
                  type="button"
                  onClick={ask.toggle}
                  aria-pressed={ask.open}
                  className={cn(
                    "hidden h-8 items-center gap-2 rounded-[13px] border px-2.5 text-compact transition-colors sm:flex",
                    ask.open
                      ? "border-orb-muted bg-orb-raised text-orb-white"
                      : "border-orb-line text-orb-muted hover:border-orb-muted hover:text-orb-white",
                  )}
                >
                  <MessagesSquare aria-hidden="true" className="size-3.5" />
                  <span>Ask</span>
                  <kbd className="rounded-[5px] border border-orb-line px-1.5 font-sans text-2xs">{ASK_SHORTCUT}</kbd>
                </button>
              )}
              {/* The theme sits in the bar rather than the account menu, where it was not found. */}
              <ThemeSwitch />
              <UserMenu email={auth.user?.email} isAdmin={Boolean(auth.user?.isAdmin)} onSignOut={signOut} disabled={busy} />
            </div>
          </header>
          <div className="flex flex-1 flex-col gap-2 px-2 pb-2 md:min-h-0 md:flex-row">
            <SectionRail items={rail.items} />
            {/* One panel holds the agents' sidebar, on their pages, and the page, with a line
                between them rather than a gap: the sidebar is the page's own navigation, not a
                second thing beside it. `overflow-hidden` keeps both inside the rounded corners. */}
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-orb-line bg-orb-space md:min-h-0 md:flex-row">
              {rail.agentsOpen && <AppSidebar agents={agents} currentPath={pathname} overviewHref={agentsHref} />}
              {/* `min-h-0` is what lets this shrink below its content's height: a flex child
                  defaults to `min-height: auto`, which would grow the row and push the sidebar's
                  foot off screen instead of scrolling here. `relative` keeps anything absolutely
                  positioned in a page (an `sr-only` label, say) scrolling with the panel rather
                  than being laid out against the document and making the window scroll. */}
              <div className="relative flex min-w-0 flex-1 flex-col md:min-h-0 md:overflow-y-auto">
                {error && <Alert variant="destructive" role="alert" className="m-4 w-auto"><AlertDescription>{error}</AlertDescription></Alert>}
                {panelWorkspaceId && extensionSlots.banners.map(({ id, Component }) => (
                  <Component key={id} workspaceId={panelWorkspaceId} api={extensionApi} />
                ))}
                {children}
              </div>
            </div>
            {/* The Ask panel: a column beside the page from `md` up, covering it below. Suspense
                because it reads the address's query, which the Library keeps on the open file. */}
            {panelWorkspaceId && (
              <Suspense fallback={null}>
                <AskPanel key={panelWorkspaceId} workspaceId={panelWorkspaceId} pageName={pageName} />
              </Suspense>
            )}
          </div>
        </div>
      )}
    </ProtectedRoute>
  );
}

/** Pages under a workspace that no rail item or agent row names. */
const OTHER_PAGES = Object.freeze({ "": "Home", markdown: "Markdown", ask: "Ask", open: "Home" });

/**
 * What the page at `pathname` is called: the rail's or the sidebar's name for the longest route
 * that contains it, or one of the few pages neither lists. Null outside a workspace.
 *
 * @param {string|null} pathname the route on screen
 * @param {Array<{name: string, href: string}>} rows every named destination in the rail and sidebar
 * @param {string|null} workspaceId the workspace on screen
 */
function pageNameFor(pathname, rows, workspaceId) {
  if (!pathname || !workspaceId) return null;
  // Compared without the workspace: the rows link into the selected workspace, which is not
  // always the one in the address.
  const within = (href) => (href ?? "").replace(/^\/workspaces\/[^/]+/, "").replace(/\/+$/, "");
  const here = within(pathname);
  const match = rows
    .map((row) => ({ name: row.name, route: within(row.href) }))
    .filter((row) => row.route && (here === row.route || here.startsWith(`${row.route}/`)))
    .sort((left, right) => right.route.length - left.route.length)[0];
  if (match) return match.name;
  return OTHER_PAGES[here.replace(/^\/+/, "").split("/")[0] ?? ""] ?? null;
}
