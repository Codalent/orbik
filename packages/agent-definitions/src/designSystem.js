import { DESIGN_SYSTEM_AGENT_SLUG } from "@orbik/core";
import { AGENT_CAPABILITIES, RUNTIME_REQUIREMENTS } from "@orbik/protocol";

/**
 * The Design system agent: a workspace's website rendered in Chrome, written down as the design
 * it has, and turned into a design system a person corrects and any AI can read.
 *
 * A definition like every other agent — it appears in the catalog, runs weekly or
 * when somebody asks, and records events and a result — but what executes it is plain code. Its
 * `runtimeRequirements` name the `design-system` runtime, and the agents worker sends such a
 * definition there instead of to a model. The instructions below are therefore documentation, not
 * a system prompt.
 *
 * It is plain code because what a site looks like is not a matter of opinion: a colour is painted
 * or it is not, and how much of the page it covers is arithmetic. It needs Google Chrome on the
 * machine running the worker.
 *
 * What a model adds comes at the end and is bounded: two questions, each answered once in a fixed
 * shape. Which of fourteen observed greys is the border colour is a judgement, and so is what a
 * site's illustrations have in common; `capability` is what those two calls are routed by, and it
 * is `reasoning` because both are asked while looking at pictures.
 *
 * **v1 observed and stored. v2 proposes**: it adds the two calls, the system they produce, the
 * pins a person lays over it, and the guide in the Library.
 *
 * **v3 no longer writes the guide.** The Brand page is where a person reads and corrects the
 * system, and `brand_get` is where an AI reads it; a copy under `/brand` in the Library was a
 * third place saying the same thing, rewritten on every pin. A run now ends once the system is
 * stored.
 */
export const DESIGN_SYSTEM = Object.freeze({
  slug: DESIGN_SYSTEM_AGENT_SLUG,
  version: 3,
  name: "Design system",
  summary:
    "Renders your site in a real browser and derives its design system: colours by role, type, spacing, shape, components, logos and the style of your imagery. Correct any value and it stays; any AI can read it over MCP.",
  capability: AGENT_CAPABILITIES.reasoning,
  tools: [],
  runtimeRequirements: [RUNTIME_REQUIREMENTS.designSystem, RUNTIME_REQUIREMENTS.crawlDataset],
  instructions: [
    "This agent is executed by plain code in the agents worker, not by a model:",
    "",
    "1. Choose the pages: the ones a person listed on the agent's setup, or else the home page and",
    "   the most linked-to page of each of the site's most linked-to route patterns, eight at most.",
    "2. Fingerprint the home page's markup and same-origin stylesheets with plain requests. When",
    "   the fingerprint is the one the stored system was derived at, stop: nothing is rendered",
    "   (STYLE_UNCHANGED). A run started with {\"force\": true} skips this check.",
    "3. Render each page in headless Chrome at 1440×900 and 390×844, one at a time. Every request",
    "   a page makes is refused unless it goes to a public address. A page that answers a browser",
    "   with a refusal is recorded as BLOCKED and the run carries on.",
    "4. Sample what was rendered, from computed styles and painted rectangles: colours weighted by",
    "   painted area or by text, text styles, spacing, radii, shadows, buttons, inputs, cards, the",
    "   navigation bar, the footer and the hero. Consent banners, chat widgets and other origins'",
    "   frames are left out.",
    "5. Reduce every page's sample into one observed record. Colours closer than a just-noticeable",
    "   difference are counted as one.",
    "6. Store the site's own logos, its largest images and its icons as assets, with screenshots,",
    "   cut-out components, a type specimen, a swatch sheet and a contact sheet. Customers' logos",
    "   and review badges on the page are not the brand's and are left out. Fonts are named, never",
    "   stored.",
    "",
    "7. Ask a model two bounded questions, each answered once as JSON in a fixed shape. Shown the",
    "   record, three screenshots and the specimen: the visual system — colours by role, typefaces",
    "   and a scale, spacing, shape, component recipes, personality and rules. Shown the contact",
    "   sheet: the graphics language, a verdict on every image, and a prompt for an image model.",
    "8. Check the answer rather than trust it. Every value carries a source — observed, derived or",
    "   proposed — and each label is audited against the record by arithmetic: a colour called",
    "   observed that is not among the observed colours is relabelled. An image judged not to be",
    "   the brand's own is hidden rather than served.",
    "9. Lay the values a person pinned over the proposal, and store the result as the workspace's",
    "   design system with the version it replaces kept.",
    "",
    "The observation is what was measured and is never edited. Anything that could not be",
    "determined is null and listed with its reason, never filled with a plausible default.",
    "",
    "A deployment with no model stores the observation and the assets all the same, and records",
    "that the proposal was skipped (PROVIDER_NOT_CONFIGURED).",
    "",
    "A site with no crawled pages gets a run that says a crawl is needed. A worker without Chrome",
    "fails the run with CHROME_UNAVAILABLE.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    description: "Nothing is required. The site comes from the run and the pages from the agent's setup or the crawl.",
    properties: {
      force: { type: "boolean", description: "Render and store again even when the site's styling has not changed." },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    required: ["state", "summary"],
    properties: {
      state: {
        type: "string",
        enum: ["no-crawl", "unchanged", "observed", "derived"],
        description: "`derived` when a system was proposed and stored; `observed` when the pages were rendered and no system could be proposed.",
      },
      skipped: { type: "string", enum: ["STYLE_UNCHANGED"], description: "Present when nothing was rendered because the styling had not changed." },
      host: { type: ["string", "null"] },
      observationId: { type: "string", description: "The stored record of what the pages showed." },
      revision: { type: ["integer", "null"], description: "The version of the design system this run stored." },
      synthesis: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["written", "partial", "skipped", "failed"], description: "What became of the two model calls. `partial` is a visual system without a graphics language." },
          reason: { type: ["object", "null"], description: "`{code, message}` when a call was skipped or failed." },
        },
      },
      summary: {
        type: "object",
        properties: {
          pages: { type: "integer", description: "Pages chosen." },
          rendered: { type: "integer" },
          blocked: { type: "integer", description: "Pages that refused a browser." },
          failed: { type: "integer" },
          colors: { type: "integer", description: "Distinct colours observed, after near-identical ones are counted as one." },
          families: { type: "integer", description: "Typefaces in use." },
          logos: { type: "integer" },
          images: { type: "integer" },
          icons: { type: "integer" },
          undetermined: { type: "integer", description: "Things that could not be read, each listed with its reason." },
          pins: { type: "integer", description: "Values a person pinned, all kept." },
          changes: { type: "integer", description: "Token values that moved since the derivation before." },
        },
      },
    },
    additionalProperties: true,
  },
});
