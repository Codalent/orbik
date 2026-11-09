import { lookup } from "node:dns/promises";

import { classifyAddress } from "@orbik/core";

import { AgentError } from "../../runtime/errors.js";
import { fontsReady, readyState, scrollThrough, visibleTextLength } from "./inPage.js";

/**
 * The two widths every page is rendered at.
 *
 * A wide desktop and a current phone: between them they show the navigation bar both ways, the
 * type scale at both ends, and whether the layout has a mobile form at all.
 */
export const VIEWPORTS = Object.freeze({
  desktop: Object.freeze({ name: "desktop", width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false }),
  mobile: Object.freeze({ name: "mobile", width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }),
});

/**
 * How Chrome is started.
 *
 * Headless, with no sandbox, GPU or first-run screens, plus two flags that matter only to
 * something that takes pictures: no scrollbars drawn into them, and one colour profile so a colour
 * read from a pixel is the colour the stylesheet named.
 */
const CHROME_FLAGS = Object.freeze([
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--no-first-run",
  "--disable-dev-shm-usage",
  "--hide-scrollbars",
  "--force-color-profile=srgb",
  "--mute-audio",
]);

/** How long one navigation may take before the page is recorded as failed. */
const NAVIGATION_TIMEOUT_MS = 30_000;

/** How long to wait for the network to go quiet once the page has loaded. */
const IDLE_TIMEOUT_MS = 8000;

/** The rest after the network is quiet, for web fonts to swap in and entrance animations to end. */
const SETTLE_MS = 1500;

/** The largest response kept from a page's own requests, in bytes. Larger images are fetched again if wanted. */
const MAX_CAPTURED_BYTES = 8 * 1024 * 1024;

/** How much of one page's image responses is held in memory at once. */
const MAX_CAPTURED_TOTAL = 80 * 1024 * 1024;

/** Words a page that refused a browser uses about itself. */
const BOT_WALL = /just a moment|attention required|verify you are (a )?human|are you a robot|access denied|captcha|checking your browser|unusual traffic/i;

/**
 * Creates the Chrome the Design system agent renders pages in.
 *
 * The libraries are loaded lazily: a worker without Chrome still starts, crawls and runs every
 * other agent, and fails only the run that needed a browser, saying so. `chrome-launcher` finds
 * and starts the installed Chrome, and `puppeteer-core` — which ships no browser of its own —
 * attaches to it.
 *
 * **A page is somebody else's program.** The site's address is checked before navigation, and
 * every request the page then makes is checked too: a public page that asks for
 * `http://169.254.169.254/` or `http://localhost:4100/` from the worker's network gets nothing.
 * The check resolves a name and Chrome connects separately, so a DNS answer that changes between
 * the two can still slip through — the same known gap the crawler's fetcher documents, and the
 * same answer: defence in depth, with the worker also kept off internal networks.
 *
 * @param {object} [options] collaborators
 * @param {() => Promise<{chromeLauncher: object, puppeteer: object}>} [options.load] imports both
 *   libraries
 * @param {typeof lookup} [options.dnsLookup] DNS resolver
 * @param {(level: string, message: string, context?: object) => void} [options.logger]
 */
export function createBrowser({ load = defaultLoad, dnsLookup = lookup, logger = () => {} } = {}) {
  const verdicts = new Map();

  /** Whether every address a host resolves to is on the public internet. Remembered per host. */
  function isPublicHost(hostname) {
    if (!verdicts.has(hostname)) {
      verdicts.set(
        hostname,
        dnsLookup(hostname, { all: true })
          .then((addresses) => addresses.length > 0 && addresses.every(({ address }) => classifyAddress(address).isPublic))
          .catch(() => false),
      );
    }
    return verdicts.get(hostname);
  }

  return {
    /** Reports whether a page could be rendered here: the libraries import and a Chrome is installed. */
    async available() {
      try {
        const { chromeLauncher } = await load();
        return (chromeLauncher.Launcher?.getInstallations?.() ?? []).length > 0;
      } catch (error) {
        logger("info", "design_system.chrome_unavailable", { message: error?.message ?? "not installed" });
        return false;
      }
    },

    /**
     * Refuses an address that is not a public web page, before anything is sent to it.
     *
     * @throws {AgentError} `BLOCKED_ADDRESS`
     */
    async assertPublicAddress(url) {
      let parsed = null;
      try {
        parsed = new URL(url);
      } catch {
        parsed = null;
      }
      if (!parsed || !["http:", "https:"].includes(parsed.protocol) || !(await isPublicHost(parsed.hostname))) {
        throw new AgentError({ code: "BLOCKED_ADDRESS", message: "That address is not a public web page.", retryable: false });
      }
    },

    /**
     * Starts one Chrome for a run and returns the session that drives it.
     *
     * One browser for the whole run rather than one per page: a speed measurement must not let one
     * page warm a cache for the next, but this is reading how pages look, and a warm cache only
     * makes eight pages of one site quicker to read.
     *
     * @param {object} [options]
     * @param {AbortSignal} [options.signal] cancellation; aborting kills Chrome
     * @returns {Promise<object>} the session; call `close()` in a `finally`
     */
    async launch({ signal } = {}) {
      const { chromeLauncher, puppeteer } = await load();
      const chrome = await chromeLauncher.launch({ chromeFlags: [...CHROME_FLAGS] });
      // `kill()` is synchronous in this chrome-launcher and returns nothing, so it is wrapped
      // rather than awaited.
      const kill = () => Promise.resolve().then(() => chrome.kill()).catch(() => {});
      const onAbort = () => { kill(); };
      signal?.addEventListener("abort", onAbort, { once: true });

      let browser;
      try {
        browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}`, defaultViewport: null });
      } catch (error) {
        signal?.removeEventListener("abort", onAbort);
        await kill();
        throw error;
      }
      // Headless Chrome announces itself as such, and a site that serves a wall to anything
      // headless would be recorded as having no design. The same browser, named as it is.
      const desktopAgent = (await browser.userAgent()).replace(/HeadlessChrome/i, "Chrome");
      const version = /Chrome\/([\d.]+)/.exec(desktopAgent)?.[1] ?? "140.0.0.0";
      const mobileAgent = `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Mobile Safari/537.36`;

      /** Opens a tab with the guard on every request it makes. */
      async function newPage(viewport) {
        const page = await browser.newPage();
        await page.setViewport({
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: viewport.deviceScaleFactor,
          isMobile: viewport.isMobile,
          hasTouch: viewport.hasTouch,
        });
        await page.setUserAgent(viewport.isMobile ? mobileAgent : desktopAgent);
        await page.setBypassServiceWorker(true);
        page.on("dialog", (dialog) => { dialog.dismiss().catch(() => {}); });
        await page.setRequestInterception(true);
        page.on("request", (request) => {
          if (request.isInterceptResolutionHandled()) return;
          const url = request.url();
          if (/^(data|blob|about):/i.test(url)) {
            request.continue().catch(() => {});
            return;
          }
          let parsed = null;
          try {
            parsed = new URL(url);
          } catch {
            parsed = null;
          }
          if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
            request.abort("blockedbyclient").catch(() => {});
            return;
          }
          isPublicHost(parsed.hostname).then((allowed) =>
            (allowed ? request.continue() : request.abort("blockedbyclient"))).catch(() => {});
        });
        return page;
      }

      return {
        /** The Chrome version doing the rendering, for the record. */
        version,

        /**
         * Renders one address at one viewport and hands the settled page to `work`.
         *
         * "Settled" is: loaded, the network quiet, web fonts in, scrolled to its foot and back so
         * nothing is still waiting to be seen. The tab is closed whatever `work` does.
         *
         * A page that answers with a refusal — a 403, a 429, a challenge screen — is reported as
         * `blocked` rather than thrown: one walled page must not cost the run the seven that
         * rendered, and a site that walls every page should be told that is what happened.
         *
         * @template T
         * @param {object} request
         * @param {string} request.url the page
         * @param {keyof typeof VIEWPORTS} request.viewport which width
         * @param {(page: object, context: {responses: Map<string, object>, status: number|null}) => Promise<T>} request.work
         * @returns {Promise<{status: "ok"|"blocked"|"failed", httpStatus: number|null, finalUrl: string|null, error: string|null, value: T|null}>}
         */
        async render({ url, viewport, work }) {
          const page = await newPage(VIEWPORTS[viewport]);
          const responses = new Map();
          let held = 0;
          page.on("response", (response) => {
            const request = response.request();
            if (request.resourceType() !== "image" || !response.ok()) return;
            const length = Number(response.headers()["content-length"] ?? 0);
            if (length > MAX_CAPTURED_BYTES || held > MAX_CAPTURED_TOTAL) return;
            response.buffer().then((buffer) => {
              if (buffer.length > MAX_CAPTURED_BYTES || held + buffer.length > MAX_CAPTURED_TOTAL) return;
              held += buffer.length;
              responses.set(response.url(), { buffer, mimeType: String(response.headers()["content-type"] ?? "").split(";")[0].trim().toLowerCase() });
            }).catch(() => {});
          });

          try {
            let response = null;
            try {
              response = await page.goto(url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
            } catch (error) {
              // A page that never fires `load` — a stalled tracker, a stream — is still a page
              // once its document is there. Anything less is a failure to render.
              const ready = await page.evaluate(readyState).catch(() => "loading");
              if (ready === "loading") {
                return { status: "failed", httpStatus: null, finalUrl: null, error: clip(error?.message ?? "The page did not load."), value: null };
              }
            }
            const httpStatus = response?.status() ?? null;
            await page.waitForNetworkIdle({ idleTime: 500, timeout: IDLE_TIMEOUT_MS }).catch(() => {});
            await page.evaluate(fontsReady).catch(() => {});

            const title = await page.title().catch(() => "");
            const words = await page.evaluate(visibleTextLength).catch(() => 0);
            if ((httpStatus !== null && [401, 403, 429, 503].includes(httpStatus)) || (BOT_WALL.test(title) && words < 600)) {
              return { status: "blocked", httpStatus, finalUrl: page.url(), error: `The site answered a browser with ${httpStatus ?? "a challenge page"}.`, value: null };
            }
            if (httpStatus !== null && httpStatus >= 400) {
              return { status: "failed", httpStatus, finalUrl: page.url(), error: `The page answered ${httpStatus}.`, value: null };
            }

            await page.evaluate(scrollThrough, { maxHeight: 16_000, pauseMs: 90 }).catch(() => {});
            await page.waitForNetworkIdle({ idleTime: 400, timeout: 4000 }).catch(() => {});
            await rest(SETTLE_MS);

            const value = await work(page, { responses, status: httpStatus });
            return { status: "ok", httpStatus, finalUrl: page.url(), error: null, value };
          } catch (error) {
            if (signal?.aborted) throw new AgentError({ code: "CANCELLED", message: "The run was cancelled.", retryable: false });
            logger("warn", "design_system.page_failed", { url, viewport, message: clip(error?.message ?? "unknown") });
            return { status: "failed", httpStatus: null, finalUrl: null, error: clip(error?.message ?? "The page could not be rendered."), value: null };
          } finally {
            await page.close().catch(() => {});
          }
        },

        /**
         * Opens a blank tab of Orbik's own, for work on bytes the worker already holds: resizing
         * an image, laying out the contact sheet. No site's script runs in it.
         */
        async blank(viewport = VIEWPORTS.desktop) {
          const page = await newPage(viewport);
          await page.setContent("<!doctype html><html><head><meta charset=\"utf-8\"></head><body style=\"margin:0;background:#fff\"></body></html>");
          return page;
        },

        /** Closes the browser and stops Chrome. Safe to call twice. */
        async close() {
          signal?.removeEventListener("abort", onAbort);
          await Promise.resolve().then(() => browser.disconnect()).catch(() => {});
          await kill();
        },
      };
    },
  };
}

/** Imports the Chrome launcher and the library that drives the Chrome it starts. */
async function defaultLoad() {
  const [chromeLauncher, { default: puppeteer }] = await Promise.all([import("chrome-launcher"), import("puppeteer-core")]);
  return { chromeLauncher, puppeteer };
}

/** Waits. */
function rest(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Keeps an error message short enough to store. */
function clip(message) {
  return String(message).replace(/\s+/g, " ").slice(0, 300);
}
