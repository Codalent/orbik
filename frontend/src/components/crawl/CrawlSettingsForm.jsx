"use client";

import { ChevronRight } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CrawlSetupGuide } from "./CrawlSetupGuide";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { crawlSettingsSchema, crawlSetupSchema } from "@/lib/validation/crawl";

/**
 * Collects the settings one crawl runs under.
 *
 * The same form creates the first configuration and edits it later, because the fields are nearly
 * identical and splitting them would mean two places to keep the bounds and copy in step.
 *
 * Crawl frequencies are not here. They are chosen per page, from the page list, once a crawl has
 * shown what the site holds; this form is about where the crawl starts and what it may read. What
 * first setup shows instead is an explanation of what a crawl actually does, which is the thing a
 * person is agreeing to when they press the button.
 *
 * @param {object} props
 * @param {object|null} props.site current configuration, or null before the first crawl is set up
 * @param {string} props.defaultSeedUrl the workspace's own website, used when no site exists yet
 * @param {(settings: object) => Promise<void>} props.onSave persists the settings
 * @param {() => void} [props.onCancel] leaves editing without saving; absent during first setup
 * @param {string|null} [props.blockedReason] why the first crawl cannot be asked for (the workspace
 *   has no crawl pages to spend); its button is disabled and this is said beside it
 */
export function CrawlSettingsForm({ site, defaultSeedUrl, onSave, onCancel, blockedReason = null }) {
  const isFirstSetup = !site;
  const savedSitemaps = site?.sitemapUrls ?? [];
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm({
    resolver: zodResolver(isFirstSetup ? crawlSetupSchema : crawlSettingsSchema),
    defaultValues: {
      seedUrl: site?.seedUrl ?? defaultSeedUrl ?? "",
      sitemapUrls: savedSitemaps.join("\n"),
    },
  });

  /** Saves settings, keeping the entered values on a recoverable failure. */
  async function save(values) {
    try {
      await onSave(values);
    } catch (error) {
      setError("root", {
        message: error?.fieldMessage?.("seedUrl")
          ?? error?.message
          ?? "The crawl settings could not be saved. Your entries are kept; try again.",
      });
    }
  }

  return (
    <form onSubmit={handleSubmit(save)} noValidate className="space-y-6">
      {errors.root && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{errors.root.message}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="crawl-seed-url">Start crawling from</Label>
        {/* Text with a URL keyboard rather than `type="url"`: a bare `example.com` is accepted and
            read as https://, which the browser's own URL check would have marked invalid. */}
        <Input
          id="crawl-seed-url"
          type="text"
          inputMode="url"
          autoComplete="url"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="example.com"
          aria-invalid={Boolean(errors.seedUrl)}
          aria-describedby={errors.seedUrl ? "crawl-seed-url-error" : "crawl-seed-url-hint"}
          {...register("seedUrl")}
        />
        {errors.seedUrl
          ? <p id="crawl-seed-url-error" className="text-sm text-destructive">{errors.seedUrl.message}</p>
          : <p id="crawl-seed-url-hint" className="text-sm text-orb-muted">Every crawl begins here and follows links and sitemaps outward. An address without https:// is read as one.</p>}
      </div>

      <SitemapField
        register={register}
        error={errors.sitemapUrls}
        defaultOpen={savedSitemaps.length > 0 || Boolean(errors.sitemapUrls)}
      />

      {/*
        Depth, page count and subdomain handling are all absent by design. Depth asks a question
        nobody has measured about their own site; how much gets fetched is the workspace's monthly
        crawl budget rather than anything a single site can state; and a subdomain is a separate
        site that belongs in its own workspace.
      */}

      {/*
        On first setup the button comes straight after the address, where a person who only wants
        to start can see it without scrolling; what a crawl does is explained underneath, for
        whoever wants to read it first.
      */}
      {isFirstSetup && (
        <SubmitRow isFirstSetup onCancel={onCancel} isSubmitting={isSubmitting} blockedReason={blockedReason} />
      )}

      {isFirstSetup ? <CrawlSetupGuide /> : (
        <>
          <p className="text-sm text-orb-muted">
            Every page starts on manual trigger. Choose crawl frequencies from the page list with
            Set crawl frequencies, or crawl pages by hand when needed.
          </p>

          <p className="text-xs text-orb-muted">
            {/* Stating the crawler's manners is the honest thing to put next to a button that sends
                traffic at somebody's server, and it is what a site owner would want to know. */}
            Orbik identifies itself as OrbikBot, obeys robots.txt, and paces its requests. It crawls
            this hostname only, one page at a time, until your monthly crawl budget runs out.
          </p>
        </>
      )}

      {!isFirstSetup && <SubmitRow onCancel={onCancel} isSubmitting={isSubmitting} />}
    </form>
  );
}

/**
 * The form's buttons. On first setup the one button starts the first crawl, and when the
 * workspace has no crawl pages it is disabled with the reason beside it, rather than queueing a
 * crawl that could fetch nothing.
 */
function SubmitRow({ isFirstSetup = false, onCancel, isSubmitting, blockedReason = null }) {
  const blocked = isFirstSetup && Boolean(blockedReason);
  return (
    <div className={isFirstSetup ? "space-y-2" : "flex justify-end gap-3"}>
      <div className="flex flex-wrap items-center gap-3">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={isSubmitting}>Cancel</Button>
        )}
        <Button type="submit" disabled={isSubmitting || blocked} aria-describedby={blocked ? "crawl-start-blocked" : undefined}>
          {isSubmitting ? "Saving…" : isFirstSetup ? "Start crawling this site" : "Save settings"}
        </Button>
      </div>
      {blocked && <p id="crawl-start-blocked" className="text-sm text-orb-orange">{blockedReason}</p>}
    </div>
  );
}

/**
 * Where the sitemaps are, for the sites where guessing does not work.
 *
 * Folded away by default, because the step above it promises Orbik finds sitemaps on its own and
 * a permanently visible field would contradict that promise for the large majority of sites where
 * it is true. It opens on its own when there is something to see: sitemaps already saved, or an
 * entry that was rejected and is now hidden behind a summary line.
 *
 * A native `details` rather than a state-driven panel: it is disclosure and nothing more, and the
 * element already handles the keyboard, the accessibility tree, and finding text inside a closed
 * section on browsers that support it.
 */
function SitemapField({ register, error, defaultOpen }) {
  return (
    <details open={defaultOpen || undefined} className="group">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-1 text-sm text-orb-gray transition-colors hover:text-orb-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orb-lime [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="size-4 shrink-0 transition-transform group-open:rotate-90" />
        Add sitemap URLs
        <span className="text-xs text-orb-muted">optional</span>
      </summary>

      <div className="mt-3 space-y-2 pl-6">
        <Label htmlFor="crawl-sitemap-urls" className="sr-only">Sitemap URLs</Label>
        <Textarea
          id="crawl-sitemap-urls"
          rows={3}
          spellCheck={false}
          placeholder={"https://example.com/sitemap.xml\nhttps://example.com/news-sitemap.xml"}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "crawl-sitemap-urls-error" : "crawl-sitemap-urls-hint"}
          {...register("sitemapUrls")}
        />
        {error
          ? <p id="crawl-sitemap-urls-error" className="text-sm text-destructive">{error.message}</p>
          : (
            <p id="crawl-sitemap-urls-hint" className="text-sm text-orb-muted">
              One per line. Orbik already checks robots.txt and the usual locations, so add these
              only if yours live somewhere unusual.
            </p>
          )}
      </div>
    </details>
  );
}
