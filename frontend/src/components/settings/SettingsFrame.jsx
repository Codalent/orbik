"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { Bot, Building2, Puzzle, ScrollText, Users } from "lucide-react";
import useSWR from "swr";

import { PageFrame } from "@/components/workspaces/PageFrame";
import * as membersApi from "@/lib/api/members";
import * as mcpApi from "@/lib/api/mcp";
import * as oauthApi from "@/lib/api/oauth";
import { WORKSPACES_PATH } from "@/lib/api/workspaces";
import { useExtensionSlots } from "@/lib/extensions/slots";
import { hostOf } from "@/lib/format";
import { cn } from "@/lib/utils";
import { roleOf } from "@/lib/workspaces/roles";

/**
 * What every Settings page sits in: the page's head, and a navigation beside it (a row of tabs
 * above it on a phone) with one link per section. Each section is a route of its own —
 * `/settings` for the workspace, `/settings/people`, `/settings/ai`, `/settings/ai-calls` (the
 * account's log of model calls, which used to be a button in the top bar), and
 * `/settings/extensions/<id>` for a section an installed extension adds — and this frame is their
 * shared layout, so the navigation stays put while the section below it changes.
 *
 * A token and an invite link are shown once, by the section that made them: going to another
 * section leaves that page, as leaving Settings always did, and takes them with it.
 *
 * The addresses the page had when it was one page that scrolled — `/settings#people`, `#ai`,
 * `#extension-<id>` — still work: arriving on `/settings` with one of them goes to its route.
 */
export function SettingsFrame({ children }) {
  const { workspaceId } = useParams();
  const pathname = usePathname();
  const router = useRouter();
  // Sections an installed extension adds, after the core ones. None in the open-source edition.
  const { settingsSections } = useExtensionSlots();
  const workspace = useSWR(WORKSPACES_PATH).data?.items?.find((item) => item.id === workspaceId) ?? null;
  const counts = useSectionCounts(workspaceId);

  const base = settingsPath(workspaceId);
  const sections = [
    { id: "workspace", title: "Workspace", icon: Building2, href: base },
    { id: "people", title: "People", icon: Users, href: `${base}/people`, count: counts.people },
    { id: "ai", title: "Orbik MCP", icon: Bot, href: `${base}/ai`, count: counts.ai },
    { id: "ai-calls", title: "AI calls", icon: ScrollText, href: `${base}/ai-calls` },
    ...settingsSections.map(({ id, title }) => ({ id: `extension-${id}`, title, icon: Puzzle, href: `${base}/extensions/${id}` })),
  ];
  const here = pathname?.replace(/\/$/, "");

  // An old link to a section's anchor on the single page: go to that section's route instead.
  useEffect(() => {
    if (here !== base) return;
    const hash = decodeURIComponent(window.location.hash.slice(1));
    if (!hash || hash === "workspace") return;
    const target = hash.startsWith("extension-")
      ? `${base}/extensions/${hash.slice("extension-".length)}`
      : { people: `${base}/people`, ai: `${base}/ai` }[hash];
    if (target) router.replace(target);
  }, [here, base, router]);

  return (
    <PageFrame label="Settings" className="max-w-6xl space-y-0 pb-16">
      <header className="mb-6 border-b border-orb-line pb-6 md:mb-8">
        <h1 className="font-display text-title font-bold leading-tight tracking-[-0.02em] text-orb-white">Settings</h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-orb-gray">
          {workspace ? (
            <>
              <span className="text-orb-white">{workspace.name}</span>
              {workspace.websiteUrl && <><span aria-hidden="true">·</span><span>{hostOf(workspace.websiteUrl)}</span></>}
              <span aria-hidden="true">·</span>
              <span>{yourRole(roleOf(workspace))}</span>
            </>
          ) : (
            "Who is in this workspace, and what may read it."
          )}
        </p>
      </header>

      <div className="grid min-w-0 gap-6 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10">
        <SectionNav sections={sections} here={here} />
        <div className="min-w-0 space-y-12">{children}</div>
      </div>
    </PageFrame>
  );
}

/** Where a workspace's Settings start: its Workspace section. */
function settingsPath(workspaceId) {
  return `/workspaces/${workspaceId}/settings`;
}

/**
 * The navigation: a sticky column of sections from `lg` up, a scrolling row of tabs above the
 * section below it. Each item is a link to its section's route; the one being viewed is marked.
 */
function SectionNav({ sections, here }) {
  return (
    <nav aria-label="Settings sections" className="min-w-0 lg:sticky lg:top-6 lg:self-start">
      <ul className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0">
        {sections.map((section) => {
          const Icon = section.icon;
          const current = here === section.href;
          return (
            <li key={section.id} className="shrink-0">
              <Link
                href={section.href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2.5 whitespace-nowrap rounded-lg border px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
                  current
                    ? "border-orb-line bg-orb-raised text-orb-white"
                    : "border-transparent text-orb-gray hover:bg-orb-raised/60 hover:text-orb-white",
                )}
              >
                <Icon aria-hidden="true" className={cn("size-4 shrink-0", current ? "text-orb-lime" : "text-orb-muted")} />
                <span className="flex-1">{section.title}</span>
                {typeof section.count === "number" && (
                  <span className="rounded-full bg-orb-line px-1.5 text-2xs tabular-nums text-orb-gray">{section.count}</span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * The figures beside the navigation's items, from the same reads the sections make — the cache
 * answers them, so nothing is asked for twice. A section whose read has not answered shows none.
 */
function useSectionCounts(workspaceId) {
  const members = useSWR(membersApi.membersPath(workspaceId)).data;
  const tokens = useSWR(mcpApi.mcpTokensPath(workspaceId)).data;
  const grants = useSWR(oauthApi.mcpGrantsPath(workspaceId)).data;

  const active = (items) => (items ?? []).filter((item) => item.status === "active").length;
  return {
    people: members ? members.members.length : null,
    ai: tokens && grants ? active(tokens.items) + active(grants.items) : null,
  };
}

/** The reader's role as the header says it: "you own it", "you're an admin", "you have read-only access". */
function yourRole(role) {
  if (role === "owner") return "you own it";
  if (role === "admin") return "you're an admin";
  if (role === "read-only") return "you have read-only access";
  return "you're a member";
}
