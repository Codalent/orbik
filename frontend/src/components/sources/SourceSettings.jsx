"use client";

import { useMemo, useState } from "react";
import { CalendarClock, Check, ChevronRight, Link2, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Panel } from "@/components/ui/panel";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { removeSource, updateSource } from "@/lib/api/sources";
import { SOURCE_FREQUENCIES, describeMonthlyCost, frequencyInterval, frequencyValue, shortUrl } from "@/lib/sources/sources";
import { useCan } from "@/lib/workspaces/roles";
import { cn } from "@/lib/utils";
import { Switch } from "./Switch";

/** A text field as the dialogs draw them. */
export const FIELD = "h-9 w-full rounded-3xl border border-transparent bg-orb-line/50 px-3 text-sm text-orb-white outline-none placeholder:text-orb-muted focus-visible:border-orb-lime focus-visible:ring-3 focus-visible:ring-orb-lime/30 aria-invalid:border-orb-coral/60 disabled:opacity-60";

/** What a person may change about a source, by kind, and the request that saves it. */
function initialValues(source) {
  return {
    name: source.name,
    seedUrl: source.seedUrl,
    mode: source.mode,
    section: source.section ?? "",
    pageUrls: source.pageUrls ?? [],
    followPagination: source.followPagination,
    exclude: (source.excludePatterns ?? []).join("\n"),
    sitemaps: (source.sitemapUrls ?? []).join("\n"),
    purpose: source.purpose,
    knowledgeUse: source.knowledgeUse,
    frequency: frequencyValue(source.pageIntervalHours),
  };
}

const lines = (text) => text.split("\n").map((line) => line.trim()).filter(Boolean);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/**
 * A source's settings, in the sections the knowledge base and the crawler read them in: where it
 * starts and how much of it (a site), or the pages it reads (pages elsewhere); what it is; how the
 * Library uses it; how often it is read. Saved together; they apply from the next read.
 *
 * @param {object} props
 * @param {string} props.workspaceId
 * @param {object} props.source the source, from the API
 * @param {object} props.detail the source's page data: its pages, its sitemaps
 * @param {Array<{id: string, label: string, guidance: string}>} props.purposes what a source can be
 * @param {() => Promise<void>} props.onSaved
 * @param {() => void} props.onRemoved
 * @param {string|null} [props.redirectedFromHost] the name the crawl was moved from, when the
 *   start address redirects to its `www.` twin (docs/guides/crawling.md)
 * @param {() => void} [props.onSetFrequencies] opens the page by page frequency picker; absent
 *   before the first crawl, when there are no pages to choose, and for a role that may not crawl
 * @param {import("react").ReactNode} [props.children] drawn after the settings and before removing
 *   the source: the Settings tab's crawl data
 */
export function SourceSettings({ workspaceId, source, detail, purposes, onSaved, onRemoved, redirectedFromHost = null, onSetFrequencies, children }) {
  const canEdit = useCan("member", workspaceId);
  const canRemove = useCan("admin", workspaceId);
  const [confirm, confirmDialog] = useConfirm();
  const start = useMemo(() => initialValues(source), [source]);
  const [values, setValues] = useState(start);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const set = (field) => (value) => { setValues((current) => ({ ...current, [field]: value })); setMessage(null); };

  const elsewhere = source.relation === "elsewhere";
  const changes = useMemo(() => {
    const out = {};
    if (values.name.trim() !== start.name && !source.primary) out.name = values.name.trim();
    if (values.purpose !== start.purpose) out.purpose = values.purpose;
    if (values.knowledgeUse !== start.knowledgeUse && !source.primary) out.knowledgeUse = values.knowledgeUse;
    if (values.frequency !== start.frequency) out.pageIntervalHours = frequencyInterval(values.frequency);
    if (values.mode !== start.mode) out.mode = values.mode;
    if (values.mode === "pages") {
      if (!same(values.pageUrls, start.pageUrls) || values.mode !== start.mode) out.pageUrls = values.pageUrls;
      if (values.followPagination !== start.followPagination) out.followPagination = values.followPagination;
    } else {
      if (values.seedUrl.trim() !== start.seedUrl) out.seedUrl = values.seedUrl.trim();
      if (values.mode === "section" && (values.section !== start.section || values.mode !== start.mode)) out.section = values.section;
      if (values.exclude !== start.exclude) out.excludePatterns = lines(values.exclude);
      if (values.sitemaps !== start.sitemaps) out.sitemapUrls = lines(values.sitemaps);
    }
    return out;
  }, [values, start, source.primary]);
  const dirty = Object.keys(changes).length > 0;

  async function save(event) {
    event.preventDefault();
    if (!dirty) return;
    setSaving(true);
    setMessage(null);
    setFieldErrors({});
    try {
      await updateSource(workspaceId, source.primary ? "website" : source.id, changes);
      await onSaved();
      setMessage({ tone: "lime", text: "Saved. The changes apply from the next read." });
    } catch (failure) {
      const fields = Object.fromEntries((failure.fields ?? []).map((field) => [field.field, field.message]));
      setFieldErrors(fields);
      setMessage({ tone: "coral", text: Object.values(fields)[0] ?? failure.message ?? "The changes could not be saved." });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    const ok = await confirm({
      title: `Remove ${source.name}?`,
      description: `Orbik stops reading ${source.host}, and ${source.libraryPath} leaves the Library with every page copied there. What the knowledge base already wrote from it stays, citing the pages it was written from. This cannot be undone.`,
      confirmLabel: "Remove source",
      destructive: true,
    });
    if (!ok) return;
    setSaving(true);
    try {
      await removeSource(workspaceId, source.id);
      onRemoved();
    } catch (failure) {
      setMessage({ tone: "coral", text: failure.message ?? "The source could not be removed." });
      setSaving(false);
    }
  }

  const purpose = purposes.find((entry) => entry.id === values.purpose);
  const pageCount = values.mode === "pages" ? Math.max(1, (detail.pages ?? []).length || values.pageUrls.length) : (source.pages?.known || 0);

  return (
    <form aria-label={`${source.name} settings`} onSubmit={save} className="flex flex-col gap-4">
      <fieldset disabled={!canEdit || saving} className="flex min-w-0 flex-col gap-4">
        {!source.primary && !elsewhere && (
          <Section title="How much of it" as="fieldset">
            <div role="radiogroup" aria-label="How much of it" className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-2">
              <Choice name="mode" checked={values.mode === "site"} onChange={() => set("mode")("site")} title="The whole site" detail="Every page that links and sitemaps lead to on this host." />
              <Choice name="mode" checked={values.mode === "section"} onChange={() => set("mode")("section")} title="One section" detail="Only addresses under a path, such as /guides/." />
              <Choice
                name="mode"
                checked={values.mode === "pages"}
                onChange={() => setValues((current) => ({ ...current, mode: "pages", pageUrls: current.pageUrls.length ? current.pageUrls : [current.seedUrl] }))}
                title="Only these pages"
                detail="Just the addresses you list. No links are followed."
              />
            </div>
            {values.mode === "section" && (
              <div className="mt-4 flex flex-col gap-2">
                <label htmlFor="source-section" className="text-sm font-medium text-orb-white">The section</label>
                <input id="source-section" type="text" spellCheck={false} placeholder="/guides/" value={values.section} onChange={(event) => set("section")(event.target.value)} aria-invalid={Boolean(fieldErrors.section) || undefined} className={cn(FIELD, "max-w-xs font-mono text-compact")} />
              </div>
            )}
          </Section>
        )}

        {elsewhere || values.mode === "pages" ? (
          <PagesSection source={source} detail={detail} values={values} set={set} error={fieldErrors.pageUrls} />
        ) : (
          <>
            <Section title="Where it starts">
              <label htmlFor="source-seed" className="block text-sm font-medium text-orb-white">Start crawling from</label>
              <input id="source-seed" type="text" inputMode="url" spellCheck={false} value={values.seedUrl} onChange={(event) => set("seedUrl")(event.target.value)} aria-invalid={Boolean(fieldErrors.seedUrl) || undefined} className={cn(FIELD, "mt-2 max-w-md")} />
              <p className="mt-2 text-compact text-orb-muted">
                {source.primary ? `Your website, ${source.host}.` : `On ${source.host}.`} Every crawl begins here and follows links and sitemaps outward, on {source.host} only.
                {redirectedFromHost && ` ${redirectedFromHost} redirects to ${source.host}, so Orbik crawls the site there.`}
              </p>
            </Section>
            <Section title={source.primary ? "How much of it" : "What to leave out"}>
              <label htmlFor="source-exclude" className="block text-sm font-medium text-orb-white">Leave out</label>
              <textarea id="source-exclude" rows={3} spellCheck={false} value={values.exclude} onChange={(event) => set("exclude")(event.target.value)} placeholder={"/v1/*\n/changelog/archive/*"} aria-invalid={Boolean(fieldErrors.excludePatterns) || undefined} className={cn(FIELD, "mt-2 h-auto max-w-md resize-y rounded-2xl py-2 font-mono text-compact leading-5")} />
              <p className="mt-2 text-compact text-orb-muted">
                {source.primary ? "Orbik reads the whole site. " : ""}Addresses starting with these are skipped. One per line; * matches anything.{detail.leftOut?.total ? ` ${detail.leftOut.total.toLocaleString("en-US")} ${detail.leftOut.total === 1 ? "page" : "pages"} left out so far.` : ""}
              </p>
              <details className="mt-4">
                <summary className="flex cursor-pointer items-center gap-1.5 text-sm font-medium text-orb-gray">
                  <ChevronRight aria-hidden="true" className="size-3.5" />Sitemaps
                  <span className="text-xs font-normal text-orb-muted">{detail.sitemaps?.length ? `${detail.sitemaps.length} found in robots.txt` : "none found in robots.txt"}</span>
                </summary>
                {detail.sitemaps?.length > 0 && (
                  <div className="mt-2 rounded-lg bg-orb-space/70 px-3 py-2 font-mono text-xs text-orb-gray">
                    {detail.sitemaps.map((url) => <div key={url} className="truncate">{shortUrl(url)}</div>)}
                  </div>
                )}
                <label htmlFor="source-sitemaps" className="mt-3 block text-compact text-orb-gray">More sitemaps, one per line</label>
                <textarea id="source-sitemaps" rows={2} spellCheck={false} value={values.sitemaps} onChange={(event) => set("sitemaps")(event.target.value)} aria-invalid={Boolean(fieldErrors.sitemapUrls) || undefined} className={cn(FIELD, "mt-1.5 h-auto max-w-md resize-y rounded-2xl py-2 font-mono text-compact leading-5")} />
              </details>
            </Section>
          </>
        )}

        <Section title="What it is" as="fieldset">
          <div role="radiogroup" aria-label="What it is" className="flex flex-wrap gap-2">
            {purposes.map((entry) => {
              const on = entry.id === values.purpose;
              return (
                <label key={entry.id} className={cn(
                  "relative inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-2xl border px-3 text-compact has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-orb-lime/70",
                  on ? "border-orb-lime/50 bg-orb-lime/10 font-medium text-orb-lime" : "border-orb-line text-orb-gray hover:border-orb-muted",
                )}>
                  <input type="radio" name="purpose" className="sr-only" checked={on} onChange={() => set("purpose")(entry.id)} />
                  {on && <Check aria-hidden="true" className="size-3.5" />}
                  {entry.label}
                </label>
              );
            })}
          </div>
          <p className="mt-3 text-compact text-orb-muted">Tells the knowledge base how to use it. {purpose?.guidance}</p>
        </Section>

        <Section title="In the Library" as="fieldset">
          {source.primary ? (
            <p className="text-compact text-orb-gray">
              Every page is copied under {source.libraryPath}, and the knowledge base is written from the pages its links point at most. The website is what the knowledge base is about.
            </p>
          ) : (
            <div role="radiogroup" aria-label="In the Library" className="grid grid-cols-[repeat(auto-fit,minmax(15rem,1fr))] gap-2">
              <Choice name="use" checked={values.knowledgeUse === "use"} onChange={() => set("knowledgeUse")("use")}
                title={elsewhere ? "Copy it, and let the knowledge base quote it" : "Copy it, and let the knowledge base use it"}
                detail={`Pages go under ${source.libraryPath}. The knowledge base may ${elsewhere ? "quote" : "choose from"} them, as it does from your website's pages.`} />
              <Choice name="use" checked={values.knowledgeUse === "copy"} onChange={() => set("knowledgeUse")("copy")}
                title="Copy it only"
                detail={`Pages go under ${source.libraryPath} for Ask and your AI tools to search. Nothing in the knowledge base is written from them.`} />
            </div>
          )}
          <p className="mt-3 flex items-center gap-1.5 text-xs text-orb-muted">
            Folder <span className="font-mono text-orb-gray">{source.libraryPath}</span> · named when the source was added
          </p>
        </Section>

        <Section title="How often">
          <label htmlFor="source-often" className="sr-only">How often</label>
          <Select items={SOURCE_FREQUENCIES} value={values.frequency} onValueChange={(next) => { if (next) set("frequency")(next); }}>
            <SelectTrigger id="source-often" className="w-full max-w-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {SOURCE_FREQUENCIES.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <p className="mt-2 text-compact text-orb-muted">
            {source.primary
              ? "How often a page is read when nobody chose for it."
              : `${describeMonthlyCost(pageCount, frequencyInterval(values.frequency))}. Orbik copies only what changed.`}
          </p>
          {onSetFrequencies && (
            // Outside the saved form's changes: the picker applies what it is given at once.
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-orb-line/70 pt-4">
              <p className="min-w-[11rem] flex-1 text-compact text-orb-muted">
                Pages or whole folders can be read daily, weekly, monthly or only when you ask, each on its own.
              </p>
              <Button type="button" variant="outline" size="sm" onClick={onSetFrequencies}>
                <CalendarClock aria-hidden="true" className="size-4" />Set crawl frequencies
              </Button>
            </div>
          )}
        </Section>

        {!source.primary && (
          <Section title="Name">
            <label htmlFor="source-name" className="sr-only">Name</label>
            <input id="source-name" type="text" value={values.name} maxLength={60} onChange={(event) => set("name")(event.target.value)} aria-invalid={Boolean(fieldErrors.name) || undefined} className={cn(FIELD, "max-w-xs")} />
          </Section>
        )}
      </fieldset>

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!dirty || saving}>{saving ? "Saving…" : "Save changes"}</Button>
          <Button type="button" variant="ghost" disabled={!dirty || saving} onClick={() => { setValues(start); setMessage(null); setFieldErrors({}); }}>Cancel</Button>
          <span role="status" className={cn("ml-auto text-xs", message?.tone === "coral" ? "text-orb-coral" : message ? "text-orb-lime" : "text-orb-muted")}>
            {message?.text ?? (elsewhere ? `Orbik reads ${source.host} as OrbikBot and obeys its robots.txt.` : "Saved changes apply from the next crawl.")}
          </span>
        </div>
      )}

      {children}

      {!source.primary && canRemove && (
        <section aria-labelledby="remove-source" className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-orb-coral/30 px-5 py-4">
          <div className="min-w-[11rem] flex-1">
            <h2 id="remove-source" className="text-sm font-semibold text-orb-white">Remove this source</h2>
            <p className="mt-1 text-compact text-orb-muted">
              Stops reading {source.host} and takes {source.libraryPath} out of the Library. What the knowledge base already wrote from it stays.
            </p>
          </div>
          <Button type="button" variant="destructive" disabled={saving} onClick={remove}>Remove source</Button>
        </section>
      )}
      {confirmDialog}
    </form>
  );
}

/** The pages a list-of-pages source reads: the ones listed, and the next pages found from them. */
function PagesSection({ source, detail, values, set, error }) {
  const [adding, setAdding] = useState("");
  const listed = values.pageUrls;
  const followed = (detail.pages ?? []).filter((page) => !page.listed && !listed.includes(page.url));
  const titleOf = (url) => (detail.pages ?? []).find((page) => page.url === url)?.title ?? null;

  function add() {
    const raw = adding.trim();
    if (!raw) return;
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/\//, "")}`;
    if (!listed.includes(url)) set("pageUrls")([...listed, url]);
    setAdding("");
  }

  return (
    <Section title="Pages Orbik reads" aside={`${listed.length + followed.length} ${listed.length + followed.length === 1 ? "page" : "pages"}, all on ${source.host}`}>
      <ul className="divide-y divide-orb-line/70 overflow-hidden rounded-lg border border-orb-line bg-orb-space/50">
        {listed.map((url) => (
          <li key={url} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 pl-4 pr-3">
            <Link2 aria-hidden="true" className="size-3.5 shrink-0 text-orb-muted" />
            <span className="min-w-[11rem] flex-1">
              <span className="block truncate font-mono text-compact text-orb-white">{shortUrl(url)}</span>
              {titleOf(url) && <span className="mt-0.5 block truncate text-xs text-orb-muted">{titleOf(url)}</span>}
            </span>
            <span className="text-xs text-orb-muted">You added it</span>
            <button
              type="button"
              aria-label={`Stop reading ${shortUrl(url)}`}
              disabled={listed.length === 1}
              onClick={() => set("pageUrls")(listed.filter((entry) => entry !== url))}
              className="grid size-7 place-items-center rounded-full text-orb-muted hover:text-orb-white disabled:opacity-40"
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          </li>
        ))}
        {followed.map((page) => (
          <li key={page.urlHash} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 pl-10 pr-3">
            <span className="min-w-[11rem] flex-1">
              <span className="block truncate font-mono text-compact text-orb-gray">{shortUrl(page.url)}</span>
              {page.title && <span className="mt-0.5 block truncate text-xs text-orb-muted">{page.title}</span>}
            </span>
            <span className="text-xs text-orb-muted">Followed from a listed page</span>
            <span aria-hidden="true" className="w-7" />
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="mt-2 text-compact text-orb-coral">{error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <label htmlFor="source-add-page" className="sr-only">Add another page</label>
        <input
          id="source-add-page"
          type="text"
          inputMode="url"
          spellCheck={false}
          value={adding}
          onChange={(event) => setAdding(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }}
          placeholder={`Add another page on ${source.host}`}
          className={cn(FIELD, "min-w-0 flex-[1_1_18rem]")}
        />
        <Button type="button" variant="outline" onClick={add}><Plus aria-hidden="true" />Add page</Button>
      </div>
      <Switch
        className="mt-4"
        checked={values.followPagination}
        onChange={set("followPagination")}
        title="Follow the listing's own “next page” links"
        detail={`For reviews split over several pages. Orbik follows only those links, only on ${source.host}, and never the rest of the site.${followed.length ? ` Found ${followed.length} more ${followed.length === 1 ? "page" : "pages"}.` : ""}`}
      />
    </Section>
  );
}

/** One bordered section of the form. */
function Section({ title, aside, as = "section", children }) {
  const Tag = as;
  return (
    <Panel>
      <Tag className="m-0 min-w-0 border-0 p-0">
        {as === "fieldset"
          ? <legend className="mb-3 p-0 text-sm font-semibold text-orb-white">{title}</legend>
          : (
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold text-orb-white">{title}</h2>
              {aside && <span className="text-xs text-orb-muted">{aside}</span>}
            </div>
          )}
        {children}
      </Tag>
    </Panel>
  );
}

/** A choice drawn as a card: a title and a line on what it means. */
function Choice({ name, checked, onChange, title, detail }) {
  return (
    <label className={cn(
      "flex cursor-pointer items-start gap-2.5 rounded-xl border px-3.5 py-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-orb-lime/70",
      checked ? "border-orb-lime/50 bg-orb-lime/5" : "border-orb-line hover:border-orb-muted",
    )}>
      <input type="radio" name={name} checked={checked} onChange={onChange} className="mt-1 accent-orb-lime" />
      <span>
        <span className="block text-sm font-medium text-orb-white">{title}</span>
        <span className="mt-0.5 block text-compact leading-[18px] text-orb-muted">{detail}</span>
      </span>
    </label>
  );
}
