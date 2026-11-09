"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Palette, RefreshCw } from "lucide-react";
import useSWR from "swr";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Panel, PanelTitle } from "@/components/ui/panel";
import { NeutralLoading } from "@/components/NeutralLoading";
import { brandPath } from "@/lib/api/brand";
import { useAgentWork } from "@/lib/agents/useAgentWork";
import { useAskPanel } from "@/lib/ask/askPanel";
import { DESIGN_SYSTEM_AGENT_SLUG } from "@/lib/brand/brand";
import { formatDate } from "@/lib/format";
import { BrandAgentStrip } from "./BrandAgentStrip";
import { BrandProvider, useBrand } from "./BrandContext";
import { BrandHistory } from "./BrandHistory";
import { BrandSources, DropTarget } from "./BrandSources";
import { BrandCard, RulesSection, ScreenshotsSection, UndeterminedSection, WhatChanged } from "./BrandOverview";
import { ColourSection } from "./ColourSection";
import { ComponentsSection } from "./ComponentsSection";
import { GraphicsSection } from "./GraphicsSection";
import { LogoSection } from "./LogoSection";
import { SpacingShapeSection } from "./SpacingShapeSection";
import { TypographySection } from "./TypographySection";
import { UseItSection } from "./UseItSection";
import { useCan } from "@/lib/workspaces/roles";

/**
 * The Brand page: a workspace's design system, to read, correct and copy out.
 *
 * What it shows is two cached reads — the brand, and the agent that derives it — and everything
 * else hangs off those. The agent sits in the page's head. Under it the system is laid out the way
 * a brand guide is read: the mark and the sentence, colour, type, logos, imagery, components,
 * spacing; then the pages it was read from, what could not be determined, and every form it is
 * copied out in.
 *
 * The states short of a system are each said as what they are. A workspace with no crawl is told
 * to crawl. One that has never derived is offered the button. One whose site was rendered but
 * whose proposal was skipped — no model configured — is told why, and still shown the logos,
 * imagery and screenshots, because those were stored all the same.
 *
 * @param {object} props
 * @param {string} props.workspaceId
 */
export function BrandDashboard({ workspaceId }) {
  const [historyOpen, setHistoryOpen] = useState(false);

  const brandRead = useSWR(brandPath(workspaceId));
  const mutateBrand = brandRead.mutate;
  const work = useAgentWork({
    workspaceId,
    agentSlug: DESIGN_SYSTEM_AGENT_SLUG,
    // A finished run replaced the proposal, the images or both.
    onFinished: mutateBrand,
  });
  const { agent, readiness, inFlight, busy } = work;
  // Deriving, choosing pages, pinning and restoring are a member's; a read-only member reads it.
  const canEdit = useCan("member", workspaceId);
  const ask = useAskPanel();
  const setAskOpen = ask?.setOpen;

  // The chat is how the brand is shaped from files and words, so on a screen wide enough for both
  // it opens beside the page when the page opens. Closing it is respected for the rest of the visit.
  useEffect(() => {
    if (canEdit && setAskOpen && window.matchMedia("(min-width: 1024px)").matches) setAskOpen(true);
  }, [canEdit, setAskOpen]);

  /** Folds what a correction returned into the cached read, without asking again. */
  const adopt = useCallback((update) => mutateBrand((current) => (current ? update(current) : current), { revalidate: false }), [mutateBrand]);

  const loading = work.loading || (!brandRead.data && !brandRead.error);
  if (loading) return <NeutralLoading label="Loading the brand" />;
  if (!agent) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription>{work.error ?? "This agent is not available. Publish the agent definitions and reload."}</AlertDescription>
      </Alert>
    );
  }

  const data = brandRead.data ?? null;
  const brand = data?.brand ?? null;
  const ready = Boolean(readiness?.crawled && readiness.markdownPages > 0);
  const derive = () => work.runWith({ force: true });
  const error = work.error ?? (!data ? brandRead.error?.message : null) ?? null;

  return (
    <div className="space-y-10">
      <BrandAgentStrip
        work={work}
        brand={brand}
        ready={ready}
        canRun={canEdit}
        description={`How ${siteHost(readiness)} looks, derived from the site as rendered in a browser. Correct anything and your value is kept; any AI you connect reads the result.`}
        onDerive={derive}
        agentHref={`/workspaces/${workspaceId}/agents/${DESIGN_SYSTEM_AGENT_SLUG}`}
        onHistory={() => setHistoryOpen(true)}
      />

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!ready && (
        <Panel>
          <PanelTitle as="h2">
            <span className="flex items-center gap-2"><Palette aria-hidden="true" className="size-4 text-orb-lime" /> Crawl your site first</span>
          </PanelTitle>
          <p className="max-w-2xl text-sm text-orb-gray">
            The design system is derived from your crawled site: the agent chooses which pages to render from what the crawler found. There is no crawl yet, so there is nothing to render.
            {canEdit ? " Or start from your own files: drop a logo, a brand guide or a font in the chat, and the brand is built from them." : ""}
          </p>
          <Link href={`/workspaces/${workspaceId}/agents/crawler`} className="mt-3 inline-block text-sm text-orb-cyan underline decoration-orb-cyan/40 underline-offset-4 hover:decoration-orb-cyan">Go to the crawler</Link>
        </Panel>
      )}

      {ready && !brand?.system && !inFlight && (
        <Panel>
          <PanelTitle as="h2">
            <span className="flex items-center gap-2"><Palette aria-hidden="true" className="size-4 text-orb-lime" /> {brand?.lastAttempt ? "Your site was rendered, but no system was proposed" : "Derive your design system"}</span>
          </PanelTitle>
          <p className="max-w-2xl text-sm text-orb-gray">
              {brand?.lastAttempt ? (
                <>
                  On {formatDate(brand.lastAttempt.at)} the pages were rendered and what they showed was stored, with your logos and images.
                  The proposal was {brand.lastAttempt.synthesis?.status ?? "not written"}
                  {attemptReason(brand.lastAttempt) && <>: {attemptReason(brand.lastAttempt)}</>}. What was collected is below.
                </>
              ) : (
                "The agent renders up to eight of your pages in a real browser, measures their colours, type, spacing and components, collects your logos and images, and proposes a system from what it measured. It takes a few minutes. Every value says whether it was observed on your site, derived from several values, or proposed to fill a gap."
              )}
          </p>
          <div className="mt-4">
            {canEdit ? (
              <Button type="button" onClick={derive} disabled={busy}>
                <RefreshCw className="size-3.5" /> {brand?.lastAttempt ? "Try again" : "Derive the design system"}
              </Button>
            ) : (
              <p className="text-sm text-orb-muted">A member of this workspace derives it.</p>
            )}
          </div>
        </Panel>
      )}

      {data && (brand?.system || data.assets.length > 0) && (
        <BrandProvider workspaceId={workspaceId} brand={brand} assets={data.assets} observation={data.observation} onChange={adopt} canEdit={canEdit}>
          <CorrectionStatus />
          {brand?.system ? (
            <>
              <BrandCard name={agentSiteName(readiness, brand)} />
              <WhatChanged brand={brand} />
              <BrandSources host={agentSiteName(readiness, brand)} observation={data.observation} />
              <DropTarget section="colours" label="Drop a brand guide or a token file" enabled={canEdit}><ColourSection /></DropTarget>
              <DropTarget section="type" label="Drop a font file or a brand guide" enabled={canEdit}><TypographySection /></DropTarget>
              <DropTarget section="logos" label="Drop to add or replace a logo" enabled={canEdit}><LogoSection /></DropTarget>
              <DropTarget section="images" label="Drop images to use as style references" enabled={canEdit}><GraphicsSection /></DropTarget>
              <ComponentsSection />
              <SpacingShapeSection />
              <RulesSection />
              <ScreenshotsSection />
              <UndeterminedSection />
              <UseItSection formats={data.formats} signedLinks={data.signedLinks} revisionKey={`${brand.revision}:${brand.updatedAt}`} />
            </>
          ) : (
            <>
              <BrandSources host={agentSiteName(readiness, brand)} observation={data.observation} />
              <DropTarget section="logos" label="Drop to add or replace a logo" enabled={canEdit}><LogoSection /></DropTarget>
              <DropTarget section="images" label="Drop images to use as style references" enabled={canEdit}><GraphicsSection /></DropTarget>
              <ScreenshotsSection />
            </>
          )}
        </BrandProvider>
      )}


      {brand?.system && (
        <BrandHistory
          workspaceId={workspaceId}
          open={historyOpen}
          current={brand.revision}
          canRestore={canEdit}
          onClose={() => setHistoryOpen(false)}
          onRestored={(restored) => adopt((current) => ({ ...current, brand: restored }))}
        />
      )}
    </div>
  );
}

/**
 * Says how the last correction went, when there is something to say.
 *
 * One place for it, at the head of the sections, because a correction can be made anywhere on the
 * page and a message beside the value would scroll away with it.
 */
function CorrectionStatus() {
  const { error } = useBrand();
  if (!error) return null;
  return (
    <Alert variant="destructive" role="alert">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );
}

/** Why a derivation produced no proposal, in the words it recorded. */
function attemptReason(attempt) {
  const reason = attempt.synthesis?.visual?.reason ?? attempt.synthesis?.graphics?.reason ?? null;
  if (!reason) return null;
  return `${reason.message}${reason.code ? ` (${reason.code})` : ""}`;
}

/** The crawled site's host, for the page's description; "your site" before there is one. */
function siteHost(readiness) {
  try {
    return new URL(readiness.siteUrl).host;
  } catch {
    return "your site";
  }
}

/** The name the brand goes by on the page: the site's host. */
function agentSiteName(readiness, brand) {
  if (brand?.host) return brand.host;
  try {
    return new URL(readiness.siteUrl).host;
  } catch {
    return "Your brand";
  }
}
