import { Bot, CalendarClock, Gauge, Radar } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * What a crawl is about to do, in the order it does it.
 *
 * Written as a sequence rather than a feature list because it is one, and because the questions
 * this answers arrive in this order: what will you read, what will you do to my server, what does
 * it cost me, and when does it happen again.
 *
 * The last step carries the accent. It is the one that says the thing this screen used to ask and
 * no longer does — how often to crawl — so it is also the answer to "where did that setting go".
 */
const STEPS = Object.freeze([
  {
    icon: Radar,
    title: "Finds every page",
    body: "Orbik reads robots.txt and your sitemaps, then follows links out from the address above. Pages nothing links to still turn up, because a sitemap lists them.",
  },
  {
    icon: Bot,
    title: "Goes easy on your server",
    body: "It arrives as OrbikBot, obeys robots.txt, and fetches one page at a time on this hostname only. Your server never sees a spike.",
  },
  {
    icon: Gauge,
    title: "Spends page budget",
    body: "Each page fetched costs one page of your monthly crawl budget. Finding URLs is free — only fetching them is charged.",
  },
  {
    icon: CalendarClock,
    title: "Settles into a schedule",
    body: "The first crawl measures how fast this site changes, and Orbik proposes how often to come back. You can change that whenever you like.",
    accent: true,
  },
]);

/**
 * Explains crawling to someone setting it up for the first time.
 *
 * Nothing here is configurable, which is the point: a screen that once asked four questions now
 * asks one, and this is where the answers went. Saying so is better than a shorter screen that
 * leaves a person guessing what Orbik decided on their behalf.
 */
export function CrawlSetupGuide() {
  return (
    <section
      aria-label="What happens when Orbik crawls"
      className="rounded-xl border border-orb-line bg-orb-raised/40 px-5 py-5"
    >
      <ol>
        {STEPS.map((step, index) => (
          <Step key={step.title} {...step} last={index === STEPS.length - 1} />
        ))}
      </ol>
    </section>
  );
}

/**
 * One step, with the hairline that joins it to the next.
 *
 * The connector is drawn by the step above rather than as a single line behind the column, because
 * only the step above knows where its own tile ends — and a line the height of the list would run
 * past the last tile into nothing.
 */
function Step({ icon: Icon, title, body, accent, last }) {
  return (
    <li className="flex gap-4">
      <div className="flex flex-col items-center">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg border",
            accent ? "border-orb-lime/40 bg-orb-lime/10" : "border-orb-line bg-orb-space",
          )}
        >
          <Icon
            aria-hidden="true"
            strokeWidth={1.75}
            className={cn("size-[18px]", accent ? "text-orb-lime" : "text-orb-gray")}
          />
        </span>
        {/* A step brighter than the panel's own hairlines. At `orb-line` the connector vanished
            against the surface behind it and the rail read as four unrelated icons, which is the
            one thing it exists not to be. */}
        {!last && <span aria-hidden="true" className="w-px flex-1 bg-orb-muted/60" />}
      </div>

      {/* The top padding centres the title against the 36px tile beside it, so the rail reads as
          rows rather than as text that happens to sit near some icons. */}
      <div className={cn("space-y-1 pt-2", last ? "pb-0" : "pb-6")}>
        <h3 className="text-sm font-semibold text-orb-white">{title}</h3>
        <p className="max-w-[62ch] text-sm leading-relaxed text-orb-gray">{body}</p>
      </div>
    </li>
  );
}
