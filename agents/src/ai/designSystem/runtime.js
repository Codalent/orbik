import { createAssetStore } from "@orbik/assets";
import {
  AGENT_COLLECTIONS,
  BRAND_ASSET_KINDS,
  BRAND_LIMITS,
  DESIGN_SYSTEM_AGENT_SLUG,
  createAgentSetupStore,
  toObjectId,
} from "@orbik/core";
import { createDesignSystemStore } from "@orbik/design-system";
import { AGENT_EVENT_TYPES } from "@orbik/protocol";
import { ObjectId } from "mongodb";

import { AgentError } from "../../runtime/errors.js";
import { createBrowser } from "./browser.js";
import { captureDesktop, captureMobile, createClipBudget } from "./capture.js";
import { styleFingerprint } from "./fingerprint.js";
import { createHarvester } from "./harvest.js";
import { selectPages } from "./pages.js";
import { reduceSamples } from "./reduce.js";
import { captureContactSheet, captureSheets } from "./sheets.js";
import { createSynthesiser, totalUsage } from "./synthesise.js";

/** The step names the run's progress events carry, so the interface can say where it is. */
const STEPS = Object.freeze({
  prepare: "prepare",
  fingerprint: "fingerprint",
  render: "render",
  sample: "sample",
  assets: "assets",
  record: "record",
  synthesise: "synthesise",
});

/**
 * What a run came to.
 *
 * Stored on the run's result so the page never has to infer one from what is missing: a site that
 * has not been crawled, a site whose styling has not moved, and a site that was rendered are
 * three different answers to "what happened".
 */
export const DERIVATION_STATES = Object.freeze({
  /** The workspace has no crawled pages, so there is no site to render. */
  noCrawl: "no-crawl",
  /** The site's styling is what the system was derived at; nothing was rendered. */
  unchanged: "unchanged",
  /**
   * The pages were rendered and what they showed was stored, and no system could be proposed from
   * it: no model is configured, or the model's answer could not be used.
   */
  observed: "observed",
  /** The pages were rendered and a system was proposed from them. */
  derived: "derived",
});

/** How many pages besides the home page also keep a picture at the mobile width. */
const EXTRA_MOBILE_SHOTS = 2;

/** How many cells the contact sheet shows: every image, and as many icons and logos as fit beside them. */
const CONTACT_SHEET_CELLS = 40;

/**
 * The runtime that executes the Design system agent: Chrome, a list of pages, and plain code that
 * writes down what the pages look like.
 *
 * It has the same shape as every other runtime — `run()` is an async generator of events that
 * returns `{result, usage}` — so the run handler, the ledger, the event log and the page treat it
 * like any other agent. Inside, a run is four moves:
 *
 * 1. **Decide whether there is anything to do.** A fingerprint of the home page's markup and
 *    stylesheets, taken with two or three plain requests. When it is the one the stored system
 *    was derived at, the run ends there: no browser, no model, nothing rewritten under the person
 *    who has been correcting the system. `{"force": true}` as the run's input skips the question.
 * 2. **Render.** A handful of pages at two widths, one at a time, in one Chrome.
 * 3. **Reduce.** What every page said becomes one record of the design as observed.
 * 4. **Harvest.** The site's own logos, images and icons become stored assets, beside the
 *    screenshots, the cut-out components and the sheets Orbik draws from them.
 * 5. **Propose.** Two bounded model calls — one shown the pages, one shown the imagery — turn the
 *    record into a system with roles, rules and a graphics language. A person's pins are laid
 *    over it, and it is stored.
 *
 * Everything up to the fifth move is measurement and needs no model. A deployment without one
 * still gets the observation and the assets, and the run says the proposal was skipped and why.
 *
 * **What it reads is decided by the run, never by input.** The site comes from the run document
 * and the pages from the agent's setup or the crawl; the only thing input can say is `force`.
 *
 * **One run, one observation.** The record is keyed by the run that wrote it, so a job the queue
 * hands back after a crash rewrites its own record, and assets are keyed by their bytes, so the
 * second attempt stores no picture twice.
 *
 * @param {object} options collaborators
 * @param {import("mongodb").Db} options.database connected database
 * @param {(level: string, message: string, context?: object) => void} options.logger
 * @param {(request: object) => Promise<object>} options.writeStructured the structured writer from
 *   `../model/structured.js`, which returns an object or why there is none and never throws
 * @param {ReturnType<typeof createBrowser>} [options.browser] the Chrome pages are rendered in
 * @param {() => Date} [options.now] clock
 */
export function createDesignSystemRuntime({ database, logger, writeStructured, browser = createBrowser({ logger }), now = () => new Date() }) {
  const observations = database.collection(AGENT_COLLECTIONS.designObservations);
  const systems = database.collection(AGENT_COLLECTIONS.designSystems);
  const sites = database.collection(AGENT_COLLECTIONS.sites);
  const markdown = database.collection(AGENT_COLLECTIONS.markdown);
  const setups = createAgentSetupStore({ database, now });
  const store = createAssetStore({ database, now });
  const designSystems = createDesignSystemStore({ database, now });
  const synthesiser = createSynthesiser({ writeStructured, assetStore: store, logger });

  /** Stores the run's observation, replacing the one an earlier attempt of the same run wrote. */
  async function record(runId, content) {
    const current = now();
    const stored = await observations.findOneAndUpdate(
      { runId },
      { $set: { ...content, updatedAt: current }, $setOnInsert: { _id: new ObjectId(), createdAt: current } },
      { upsert: true, returnDocument: "after" },
    );
    if (!stored) {
      throw new AgentError({ code: "OBSERVATION_NOT_STORED", message: "What the pages showed could not be stored.", retryable: true });
    }
    // The newest few are enough: the latest is what is shown, and the one before it is what
    // "what changed" is compared with.
    const stale = await observations
      .find({ workspaceId: stored.workspaceId })
      .project({ _id: 1 })
      .sort({ createdAt: -1 })
      .skip(BRAND_LIMITS.observations)
      .toArray();
    if (stale.length) await observations.deleteMany({ _id: { $in: stale.map((row) => row._id) } });
    return stored;
  }

  return {
    name: "design-system",

    /**
     * Derives the run's site, and yields progress as it goes.
     *
     * @param {object} request what to run
     * @param {object} request.definition the dispatched definition
     * @param {object} [request.input] `{force?: boolean}`
     * @param {AbortSignal} [request.signal] cancellation from the worker
     * @param {() => Promise<boolean>} [request.isCancelled] asked between pages
     * @param {object} request.trace `{runId, workspaceId, siteId}`, from the run document
     * @yields {object} events matching `@orbik/protocol`'s `parseAgentEvent`
     * @returns {Promise<{result: object, usage: object|null}>}
     */
    async *run({ definition, input = {}, signal, isCancelled, trace }) {
      yield { type: AGENT_EVENT_TYPES.started };
      const workspaceId = toObjectId(trace.workspaceId);
      const runId = toObjectId(trace.runId);
      const siteId = trace.siteId ? toObjectId(trace.siteId) : null;
      const agentSlug = definition?.slug ?? DESIGN_SYSTEM_AGENT_SLUG;
      const forced = input?.force === true;

      /** Stops the run when somebody asked for that, before any more work is done. */
      const stopIfCancelled = async () => {
        if (signal?.aborted || (await isCancelled?.())) {
          throw new AgentError({ code: "CANCELLED", message: "The run was cancelled.", retryable: false });
        }
      };

      yield { type: AGENT_EVENT_TYPES.progress, step: STEPS.prepare, message: "Reading the crawl to choose the pages" };
      const site = siteId ? await sites.findOne({ _id: siteId }, { projection: { seedUrl: 1 } }) : null;
      const crawled = site ? await markdown.countDocuments({ siteId }, { limit: 1 }) : 0;
      if (!site?.seedUrl || !crawled) {
        // A design system is read from the crawled site, so without one there is nothing to
        // render. Said as an outcome rather than a failure: nothing went wrong, and the page can
        // tell the person exactly what to do next.
        const result = { state: DERIVATION_STATES.noCrawl, host: null, summary: emptySummary() };
        yield { type: AGENT_EVENT_TYPES.progress, step: STEPS.prepare, message: "The site has not been crawled yet, so there are no pages to render" };
        yield { type: AGENT_EVENT_TYPES.completed, result };
        return { result, usage: null };
      }

      const setup = await setups.find({ workspaceId, agentSlug });
      const { pages, source } = await selectPages({ database, siteId, seedUrl: site.seedUrl, chosen: setup?.pages ?? [] });
      const origin = new URL(pages[0].url).origin;
      const host = new URL(pages[0].url).host;

      // ---- 1. Is there anything to do?
      yield { type: AGENT_EVENT_TYPES.progress, step: STEPS.fingerprint, message: "Checking whether the site's styling has changed" };
      const fingerprinted = await styleFingerprint({
        homeUrl: pages[0].url,
        pageUrls: pages.map((page) => page.url),
        assertPublicAddress: browser.assertPublicAddress,
        signal,
      });
      const existing = await systems.findOne({ workspaceId }, { projection: { styleFingerprint: 1, derivedAt: 1 } });
      if (!forced && fingerprinted.fingerprint && existing?.styleFingerprint === fingerprinted.fingerprint) {
        const result = {
          state: DERIVATION_STATES.unchanged,
          skipped: "STYLE_UNCHANGED",
          host,
          derivedAt: existing.derivedAt ? existing.derivedAt.toISOString() : null,
          summary: emptySummary(),
        };
        yield { type: AGENT_EVENT_TYPES.progress, step: STEPS.fingerprint, message: "The styling is what the system was derived from; nothing to do (STYLE_UNCHANGED)" };
        yield { type: AGENT_EVENT_TYPES.completed, result };
        return { result, usage: null };
      }

      if (!(await browser.available())) {
        throw new AgentError({
          code: "CHROME_UNAVAILABLE",
          message: "Deriving a design system needs Google Chrome installed on the machine running the agents worker.",
          retryable: false,
        });
      }

      // ---- 2. Render
      await stopIfCancelled();
      const session = await browser.launch({ signal });
      let stored;
      try {
        const harvester = createHarvester({
          session,
          store,
          workspaceId,
          runId,
          origin,
          assertPublicAddress: browser.assertPublicAddress,
          signal,
          logger,
        });
        const clipBudget = createClipBudget();
        const rendered = [];
        const clipAssets = new Map();
        let desktopIndex = 0;

        for (const [index, page] of pages.entries()) {
          await stopIfCancelled();
          yield { type: AGENT_EVENT_TYPES.progress, step: STEPS.render, message: `Rendering ${index + 1} of ${pages.length}: ${page.label}`.slice(0, 300) };
          const entry = { page, status: "failed", httpStatus: null, error: null, desktop: null, mobile: null, clips: [], shots: {} };
          rendered.push(entry);

          let desktop;
          try {
            await browser.assertPublicAddress(page.url);
            desktop = await session.render({ url: page.url, viewport: "desktop", work: (tab, context) => captureDesktop(tab, { ...context, clips: clipBudget }) });
          } catch (error) {
            if (error?.code === "CANCELLED" || signal?.aborted) throw error;
            desktop = { status: "failed", httpStatus: null, error: String(error?.message ?? "The page could not be rendered.").slice(0, 300), value: null };
          }
          entry.status = desktop.status;
          entry.httpStatus = desktop.httpStatus;
          entry.error = desktop.error;
          if (desktop.status !== "ok") {
            yield { type: AGENT_EVENT_TYPES.progress, step: STEPS.render, message: `${page.label}: ${desktop.status === "blocked" ? "BLOCKED" : "could not be rendered"} (${desktop.error})`.slice(0, 300) };
            continue;
          }

          const captured = desktop.value;
          entry.desktop = captured.sample;
          entry.clips = captured.clips;
          harvester.hold(captured.sample, captured.responses);
          const isHome = index === 0;
          const shotMeta = { pageUrl: page.url, width: captured.sample.view.width };
          entry.shots.desktop = (await harvester.keepCapture({
            kind: BRAND_ASSET_KINDS.screenshot,
            buffer: captured.shots.viewport,
            meta: { ...shotMeta, height: captured.sample.view.height, viewport: "desktop", label: `${page.label} — desktop`, position: isHome ? "home" : "page" },
          }))?.id ?? null;
          if (isHome && captured.shots.full) {
            entry.shots.full = (await harvester.keepCapture({
              kind: BRAND_ASSET_KINDS.screenshot,
              buffer: captured.shots.full,
              meta: { ...shotMeta, height: Math.min(captured.sample.pageHeight, BRAND_LIMITS.fullPageHeight), viewport: "full", label: `${page.label} — full page`, position: "home" },
            }))?.id ?? null;
          }
          for (const clip of captured.clips) {
            // A logo set in type is stored by the logo harvest, as a logo, not as a clip.
            if (clip.kind === "logo") continue;
            const reference = await harvester.keepCapture({
              kind: BRAND_ASSET_KINDS.clip,
              buffer: clip.buffer,
              mimeType: clip.mimeType,
              meta: { pageUrl: page.url, width: clip.width, height: clip.height, label: clip.key, position: clip.kind },
            });
            if (reference) clipAssets.set(`${desktopIndex}:${clip.key}`, reference.id);
          }
          desktopIndex += 1;

          // The narrow width: how the type and the navigation change, and a picture of it.
          await stopIfCancelled();
          const mobile = await session.render({ url: page.url, viewport: "mobile", work: (tab) => captureMobile(tab) }).catch((error) => {
            if (error?.code === "CANCELLED" || signal?.aborted) throw error;
            return { status: "failed", value: null };
          });
          if (mobile.status === "ok") {
            entry.mobile = mobile.value.sample;
            if (index <= EXTRA_MOBILE_SHOTS) {
              entry.shots.mobile = (await harvester.keepCapture({
                kind: BRAND_ASSET_KINDS.screenshot,
                buffer: mobile.value.shots.viewport,
                meta: { pageUrl: page.url, width: mobile.value.sample.view.width, height: mobile.value.sample.view.height, viewport: "mobile", label: `${page.label} — mobile`, position: isHome ? "home" : "page" },
              }))?.id ?? null;
            }
          }
          yield {
            type: AGENT_EVENT_TYPES.progress,
            step: STEPS.render,
            message: `${page.label}: ${captured.sample.colours.length} colours, ${captured.sample.typography.length} text styles, ${captured.sample.images.length + captured.sample.svgs.length} images`.slice(0, 300),
          };
        }

        const ok = rendered.filter((entry) => entry.desktop);
        if (!ok.length) {
          const blocked = rendered.filter((entry) => entry.status === "blocked").length;
          throw new AgentError({
            code: blocked === rendered.length ? "SITE_BLOCKED" : "DESIGN_RENDER_FAILED",
            message: blocked === rendered.length
              ? "The site refused a browser on every page (BLOCKED), so nothing could be rendered."
              : `None of the ${rendered.length} pages could be rendered. ${rendered[0]?.error ?? ""}`.trim().slice(0, 500),
            retryable: false,
          });
        }

        // ---- 3. Reduce
        await stopIfCancelled();
        yield { type: AGENT_EVENT_TYPES.progress, step: STEPS.sample, message: `Reducing what ${ok.length} ${ok.length === 1 ? "page" : "pages"} showed into one record` };
        const observed = reduceSamples({ host, rendered });
        for (const group of [observed.components.buttons, observed.components.inputs, observed.components.cards]) {
          for (const recipe of group) recipe.clip = recipe.clip ? clipAssets.get(recipe.clip) ?? null : null;
        }
        for (const field of ["nav", "footer", "hero"]) {
          const component = observed.components[field];
          if (component) component.clip = component.clip ? clipAssets.get(component.clip) ?? null : null;
        }

        // ---- 4. Harvest
        await stopIfCancelled();
        yield { type: AGENT_EVENT_TYPES.progress, step: STEPS.assets, message: "Collecting the site's logos, images and icons" };
        const harvestPages = ok.map((entry) => ({ page: entry.page, sample: entry.desktop, clips: entry.clips }));
        const logos = await harvester.logos(harvestPages, observed.document);
        const logoSources = new Set(ok.flatMap((entry) => entry.desktop.logos.flatMap((logo) => [logo.src, logo.source])).filter(Boolean));
        await stopIfCancelled();
        const imagery = await harvester.imagery(harvestPages, observed.document, logoSources);
        if (!logos.length) observed.undetermined.push({ field: "logos", reason: "No logo image, vector or text wordmark was found in the header or footer, and the site declares no icon." });
        if (!imagery.images.length) observed.undetermined.push({ field: "graphics.imagery", reason: "No photograph or illustration of the site's own was found on the rendered pages." });
        if (!imagery.icons.length) observed.undetermined.push({ field: "graphics.iconography", reason: "No icon or inline vector drawing was found on the rendered pages." });

        await stopIfCancelled();
        yield { type: AGENT_EVENT_TYPES.progress, step: STEPS.assets, message: "Drawing the type specimen, the swatches and the contact sheet" };
        const sheets = {};
        const drawn = await session.render({ url: ok[0].page.url, viewport: "desktop", work: (tab) => captureSheets(tab, observed) });
        for (const sheet of drawn.value ?? []) {
          const reference = await harvester.keepCapture({ kind: sheet.kind, buffer: sheet.buffer, meta: { width: sheet.width, height: sheet.height, label: sheet.label, pageUrl: ok[0].page.url } });
          if (reference) sheets[sheet.kind === BRAND_ASSET_KINDS.specimen ? "specimen" : "swatches"] = reference.id;
        }
        if (!sheets.specimen) observed.undetermined.push({ field: "typography.specimen", reason: "The type specimen could not be drawn on the site's page." });

        const numbered = [...imagery.images, ...imagery.icons, ...logos].slice(0, CONTACT_SHEET_CELLS).map((asset, index) => ({ ...asset, number: index + 1 }));
        const cells = [];
        for (const asset of numbered) {
          const row = await store.find({ workspaceId, assetId: asset.id });
          if (!row) continue;
          const bytes = await store.read(row);
          cells.push({
            number: asset.number,
            kind: asset.kind === BRAND_ASSET_KINDS.logo ? `logo (${asset.variant ?? "mark"})` : asset.kind,
            width: asset.width,
            height: asset.height,
            dataUrl: `data:${row.mimeType};base64,${bytes.toString("base64")}`,
            // A mark drawn for a dark background is shown on one, or it would be a white square.
            background: asset.tone === "on-dark" ? "#111827" : undefined,
          });
        }
        const contact = await captureContactSheet(await harvester.toolPage(), { host, cells });
        if (contact) {
          const reference = await harvester.keepCapture({ kind: contact.kind, buffer: contact.buffer, meta: { width: contact.width, height: contact.height, label: contact.label } });
          if (reference) sheets.contactSheet = reference.id;
        }
        await harvester.close();

        // ---- Record
        yield { type: AGENT_EVENT_TYPES.progress, step: STEPS.record, message: "Recording what was observed" };
        stored = await record(runId, {
          workspaceId,
          siteId,
          runId,
          agentVersion: definition.version,
          host,
          forced,
          styleFingerprint: fingerprinted.fingerprint,
          fingerprintReason: fingerprinted.reason,
          chrome: session.version,
          pageSource: source,
          pages: rendered.map((entry) => ({
            url: entry.page.url,
            label: entry.page.label,
            pattern: entry.page.pattern,
            reason: entry.page.reason,
            status: entry.status,
            httpStatus: entry.httpStatus,
            error: entry.error,
            title: entry.desktop?.document.title ?? entry.page.title ?? null,
            height: entry.desktop?.pageHeight ?? null,
            elements: entry.desktop?.visited ?? null,
            truncated: entry.desktop?.truncated ?? false,
            shots: entry.shots,
          })),
          observed,
          assets: {
            logos,
            images: imagery.images,
            icons: imagery.icons,
            sheets,
            // The order the contact sheet numbers them in, which is how a model's answer about
            // "image 4" is turned back into an asset.
            numbered: numbered.map((asset) => ({ number: asset.number, id: asset.id, kind: asset.kind })),
            seen: imagery.seen,
          },
        });

        const pruned = await store.prune({ workspaceId, runId, rank: rankAsset });
        logger("info", "design_system.observed", {
          runId: runId.toHexString(),
          host,
          pages: ok.length,
          colours: observed.colors.length,
          logos: logos.length,
          images: imagery.images.length,
          icons: imagery.icons.length,
          pruned,
        });
      } finally {
        await session.close();
      }

      // ---- 5. Propose
      await stopIfCancelled();
      const modelTrace = { runId, workspaceId, siteId };
      yield { type: AGENT_EVENT_TYPES.progress, step: STEPS.synthesise, message: "Proposing the visual system from what was observed" };
      const visual = await synthesiser.visual({ observation: stored, definition, trace: modelTrace, signal });
      if (visual.status !== "written") {
        yield { type: AGENT_EVENT_TYPES.progress, step: STEPS.synthesise, message: `Visual system ${visual.status}: ${visual.reason.message}`.slice(0, 300) };
      }

      // The graphics language is asked for even when the first call gave nothing: it is a
      // separate question about separate evidence. It is stored only with a system to belong to.
      let graphics = { status: "skipped", graphics: null, verdicts: [], reason: visual.reason, model: null, usage: null };
      if (visual.status !== "skipped" && visual.reason?.code !== "CANCELLED") {
        await stopIfCancelled();
        yield { type: AGENT_EVENT_TYPES.progress, step: STEPS.synthesise, message: "Describing the graphics language from the contact sheet" };
        graphics = await synthesiser.graphics({ observation: stored, visual: visual.visual, definition, trace: modelTrace, signal });
        if (graphics.status === "skipped" || graphics.status === "failed") {
          yield { type: AGENT_EVENT_TYPES.progress, step: STEPS.synthesise, message: `Graphics language ${graphics.status}: ${graphics.reason.message}`.slice(0, 300) };
        }
      }

      const synthesis = {
        status: visual.status === "written" ? (graphics.status === "written" || graphics.status === "not-needed" ? "written" : "partial") : visual.status,
        visual: { status: visual.status, model: visual.model, reason: visual.reason },
        graphics: { status: graphics.status, model: graphics.model, reason: graphics.reason },
      };
      const usage = totalUsage(visual, graphics);
      let system = null;

      if (visual.status === "written") {
        // What the model said about each image: its caption, whether it is the brand's own, and
        // whether it is a reference. A flag a person set is left as they set it.
        if (graphics.verdicts.length) {
          await store.annotate({
            workspaceId,
            notes: graphics.verdicts.map((verdict) => ({ id: verdict.id, caption: verdict.caption, isReference: verdict.isReference, hidden: !verdict.belongs, kind: verdict.kind })),
          });
        }
        const proposal = buildProposal({ visual: visual.visual, graphics, stored });
        yield { type: AGENT_EVENT_TYPES.progress, step: STEPS.record, message: "Storing the proposed system, with every pinned value kept" };
        system = await designSystems.saveDerivation({
          workspaceId,
          siteId,
          host,
          runId,
          observationId: stored._id,
          agentVersion: definition.version,
          // Remembered only for a complete derivation: an incomplete one should be tried again
          // next time, not mistaken for the system this styling produces.
          styleFingerprint: synthesis.status === "written" ? stored.styleFingerprint : null,
          proposal,
          synthesis,
          pages: stored.pages.filter((page) => page.status === "ok").map((page) => ({ url: page.url, label: page.label })),
        });
      } else {
        await designSystems.recordAttempt({ workspaceId, siteId, host, runId, observationId: stored._id, synthesis });
      }
      logger("info", "design_system.derived", {
        runId: runId.toHexString(),
        host,
        synthesis: synthesis.status,
        revision: system?.revision ?? null,
        pins: system?.pins?.length ?? 0,
      });

      // Somebody stopped the run while a model was being asked. What was observed is stored — it
      // was complete before the model was asked — and the run still ends as stopped.
      if (visual.reason?.code === "CANCELLED" || graphics.reason?.code === "CANCELLED") {
        throw new AgentError({ code: "CANCELLED", message: "The run was cancelled.", retryable: false });
      }

      const result = {
        state: system ? DERIVATION_STATES.derived : DERIVATION_STATES.observed,
        host,
        observationId: stored._id.toHexString(),
        revision: system?.revision ?? null,
        synthesis: {
          status: synthesis.status,
          reason: (visual.reason ?? graphics.reason) ? { code: (visual.reason ?? graphics.reason).code, message: (visual.reason ?? graphics.reason).message } : null,
        },
        summary: { ...summarise(stored), pins: system?.pins?.length ?? 0, changes: system?.changes?.length ?? 0 },
      };
      yield { type: AGENT_EVENT_TYPES.completed, result };
      return { result, usage };
    },
  };
}

/**
 * Assembles the proposal that is stored: the visual system, the graphics language, and the things
 * the worker knows without asking — which logo is the main one, and what could not be read.
 *
 * What could not be determined is the union of two lists: what the measurement could not find,
 * and what the model declined to guess. Neither is dropped in favour of the other.
 */
function buildProposal({ visual, graphics, stored }) {
  const undetermined = [...stored.observed.undetermined];
  for (const entry of visual.undetermined) {
    if (!undetermined.some((known) => known.field === entry.field)) undetermined.push(entry);
  }
  if (graphics.status === "skipped" || graphics.status === "failed") {
    undetermined.push({ field: "graphics", reason: `The graphics language could not be described: ${graphics.reason.message}` });
  } else if (graphics.status === "not-needed") {
    undetermined.push({ field: "graphics", reason: "No image, icon or logo of the site's own was collected, so there is no imagery to describe." });
  }
  return {
    ...visual,
    graphics: graphics.graphics,
    // The mark most certainly the company's: the one found in the header's link home.
    logos: { primary: stored.assets.logos[0]?.id ?? null },
    undetermined,
  };
}

/**
 * How dispensable an asset is when a workspace holds more than it may: lower is kept longer.
 *
 * The marks and the sheets first, because they are what an outside AI is handed; then the home
 * page's pictures and the cut-out components the Brand page compares the proposal with; then the
 * site's imagery; and last the other pages' screenshots, which say the least that nothing else
 * says.
 */
function rankAsset(asset) {
  switch (asset.kind) {
    case BRAND_ASSET_KINDS.logo:
      return 0;
    case BRAND_ASSET_KINDS.specimen:
    case BRAND_ASSET_KINDS.swatches:
    case BRAND_ASSET_KINDS.contactSheet:
      return 1;
    case BRAND_ASSET_KINDS.clip:
      return 2;
    case BRAND_ASSET_KINDS.screenshot:
      if (asset.position === "home") return 3;
      return asset.viewport === "mobile" ? 7 : 6;
    case BRAND_ASSET_KINDS.photo:
    case BRAND_ASSET_KINDS.illustration:
      return 4;
    default:
      return 5;
  }
}

/** The counts a run's result carries: enough for a list of runs to say what each one saw. */
function summarise(stored) {
  const pages = stored.pages ?? [];
  return {
    pages: pages.length,
    rendered: pages.filter((page) => page.status === "ok").length,
    blocked: pages.filter((page) => page.status === "blocked").length,
    failed: pages.filter((page) => page.status === "failed").length,
    colors: stored.observed.colors.length,
    families: stored.observed.fonts.families.length,
    logos: stored.assets.logos.length,
    images: stored.assets.images.length,
    icons: stored.assets.icons.length,
    undetermined: stored.observed.undetermined.length,
  };
}

/** The summary of a run that rendered nothing. */
function emptySummary() {
  return { pages: 0, rendered: 0, blocked: 0, failed: 0, colors: 0, families: 0, logos: 0, images: 0, icons: 0, undetermined: 0 };
}
