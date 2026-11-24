"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Globe, Info, Quote } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { addSource, checkSource } from "@/lib/api/sources";
import { SOURCE_FREQUENCIES, describeMonthlyCost, frequencyInterval } from "@/lib/sources/sources";
import { cn } from "@/lib/utils";
import { FIELD } from "./SourceSettings";
import { Switch } from "./Switch";

/** How long typing pauses before the address is checked. */
const CHECK_AFTER_MS = 600;

/**
 * Add a source: paste an address and Orbik works out what it is — a site of yours or a page about
 * you elsewhere, what kind of page, whether it answers and lets OrbikBot in — and suggests a name.
 * A person can say otherwise about any of it; picking "a site of yours" for somebody else's
 * site says what that would cost.
 *
 * @param {object} props
 * @param {string} props.workspaceId
 * @param {string} [props.initialUrl] an address to start from, from "Found on your website"
 * @param {Array<{id: string, label: string, guidance: string}>} props.purposes
 * @param {() => void} props.onClose
 * @param {(source: object) => void} props.onAdded
 */
export function AddSourceDialog({ workspaceId, initialUrl = "", purposes, onClose, onAdded }) {
  const field = useRef(null);
  const [url, setUrl] = useState(initialUrl);
  // What the last check found, and for which address: an answer for an address since changed is
  // not shown, so nothing has to be cleared when the address is.
  const [checked, setChecked] = useState({ for: null, result: null, error: null });
  const [checkingFor, setCheckingFor] = useState(null);
  const [relation, setRelation] = useState(null);
  const [purpose, setPurpose] = useState(null);
  const [name, setName] = useState("");
  const [frequency, setFrequency] = useState("168");
  const [followPagination, setFollowPagination] = useState(true);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState(null);
  const touched = useRef({ name: false, purpose: false, relation: false });

  // The address is checked a moment after typing stops: what it is, and whether it can be read.
  const address = url.trim();
  const checkable = Boolean(address) && /\./.test(address);
  useEffect(() => {
    if (!checkable) return undefined;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setCheckingFor(address);
      try {
        const result = await checkSource(workspaceId, address);
        if (cancelled) return;
        setChecked({ for: address, result, error: null });
        if (!touched.current.relation) setRelation(result.suggested.relation);
        if (!touched.current.purpose) setPurpose(result.suggested.purpose);
        if (!touched.current.name) setName(result.suggested.name);
        setFollowPagination(result.suggested.followPagination);
      } catch (error) {
        if (cancelled) return;
        setChecked({ for: address, result: null, error: error.fields?.[0]?.message ?? error.message ?? "That address could not be checked." });
      } finally {
        if (!cancelled) setCheckingFor(null);
      }
    }, CHECK_AFTER_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [address, checkable, workspaceId]);
  const current = checkable && checked.for === address;
  const check = current ? checked.result : null;
  const checkError = current ? checked.error : null;
  const checking = checkable && (checkingFor === address || checked.for !== address);

  const host = check?.host ?? null;
  const elsewhere = relation === "elsewhere";
  const ownSuggested = check?.suggested.relation === "own";
  const unreadable = check?.known && !check.known.readable;
  const blocked = Boolean(check?.conflict) || unreadable || check?.full || (check && !check.websiteSetUp);
  const chosen = purposes.find((entry) => entry.id === purpose) ?? null;
  const ready = Boolean(check && relation && purpose && name.trim() && !blocked && !checking);

  async function submit(event) {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await addSource(workspaceId, {
        url: check.url,
        relation,
        name: name.trim(),
        purpose,
        pageIntervalHours: frequencyInterval(frequency),
        ...(elsewhere ? { followPagination } : {}),
      });
      onAdded(result.source);
    } catch (error) {
      setFailure(error.fields?.[0]?.message ?? error.message ?? "The source could not be added.");
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogContent initialFocus={field} className="max-w-150">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <div className="px-6 pt-5 pb-1 pr-14">
            <DialogTitle className="font-sans text-lg font-semibold leading-6 text-orb-white">Add a source</DialogTitle>
            <DialogDescription className="mt-1 text-sm text-orb-gray">
              Paste the address of another site of yours, or of a page about you. Orbik works out which it is.
            </DialogDescription>
          </div>

          <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-6 pt-4 pb-5">
            <div className="flex flex-col gap-2">
              <label htmlFor="add-source-url" className="text-sm font-medium text-orb-white">Address</label>
              <input
                ref={field}
                id="add-source-url"
                type="text"
                inputMode="url"
                spellCheck={false}
                autoComplete="off"
                placeholder="docs.example.com, or clutch.co/profile/example"
                value={url}
                onChange={(event) => { setUrl(event.target.value); setFailure(null); }}
                aria-invalid={Boolean(checkError) || undefined}
                aria-describedby="add-source-found"
                className={FIELD}
              />
              <AddressFinding id="add-source-found" check={check} checking={checking} error={checkError} />
            </div>

            {check && !blocked && (
              <>
                <fieldset className="flex min-w-0 flex-col gap-2 border-0 p-0">
                  <legend className="mb-2 p-0 text-sm font-medium text-orb-white">What kind of source</legend>
                  <div role="radiogroup" aria-label="What kind of source" className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-2">
                    <KindCard
                      icon={Globe}
                      checked={relation === "own"}
                      onPick={() => { touched.current.relation = true; setRelation("own"); }}
                      title="A site of yours"
                      detail={`A subdomain such as docs.${check.website?.domain ?? "example.com"}, or another domain you own. Orbik follows every link on it.`}
                    />
                    <KindCard
                      icon={Quote}
                      checked={relation === "elsewhere"}
                      onPick={() => { touched.current.relation = true; setRelation("elsewhere"); }}
                      title="Pages about you elsewhere"
                      detail="A review profile, a directory listing, a press article. Orbik reads only the pages you list."
                    />
                  </div>
                  {elsewhere && !ownSuggested && (
                    <Note tone="cyan">{host} is not {check.website?.domain} or one of its subdomains, so Orbik suggests reading it as pages about you.</Note>
                  )}
                  {relation === "own" && !ownSuggested && (
                    <Note tone="orange" role="alert">
                      {host} does not look like a site of yours. As one, Orbik would follow every link on {host}: all of its pages, charged to this workspace’s crawl budget.
                    </Note>
                  )}
                  {elsewhere && (
                    <Switch
                      className="pt-1"
                      checked={followPagination}
                      onChange={setFollowPagination}
                      title="Follow its own “next page” links"
                      detail={`For reviews split over several pages. Only those links, only on ${host}.`}
                    />
                  )}
                </fieldset>

                <fieldset className="min-w-0 border-0 p-0">
                  <legend className="mb-2 p-0 text-sm font-medium text-orb-white">What it is</legend>
                  <div role="radiogroup" aria-label="What it is" className="flex flex-wrap gap-2">
                    {purposes.map((entry) => {
                      const on = entry.id === purpose;
                      return (
                        <label key={entry.id} className={cn(
                          "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-2xl border px-3 text-compact has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-orb-lime/70",
                          on ? "border-orb-lime/50 bg-orb-lime/10 font-medium text-orb-lime" : "border-orb-line text-orb-gray hover:border-orb-muted",
                        )}>
                          <input type="radio" name="add-source-purpose" className="sr-only" checked={on} onChange={() => { touched.current.purpose = true; setPurpose(entry.id); }} />
                          {on && <Check aria-hidden="true" className="size-3.5" />}
                          {entry.label}
                        </label>
                      );
                    })}
                  </div>
                  {chosen && <p className="mt-2 text-compact text-orb-muted">{chosen.guidance}</p>}
                </fieldset>

                <div className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-4">
                  <div className="flex flex-col gap-2">
                    <label htmlFor="add-source-name" className="text-sm font-medium text-orb-white">Name</label>
                    <input id="add-source-name" type="text" maxLength={60} value={name} onChange={(event) => { touched.current.name = true; setName(event.target.value); }} className={FIELD} />
                    <p className="text-xs text-orb-muted">Copied into /sources/{check.suggested.folder}</p>
                  </div>
                  <div className="flex flex-col gap-2">
                    <label htmlFor="add-source-often" className="text-sm font-medium text-orb-white">How often</label>
                    <Select items={SOURCE_FREQUENCIES} value={frequency} onValueChange={(next) => { if (next) setFrequency(next); }}>
                      <SelectTrigger id="add-source-often" className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {SOURCE_FREQUENCIES.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-orb-muted">
                      {elsewhere ? describeMonthlyCost(1, frequencyInterval(frequency)) : "Each page is read again at this pace; set single pages otherwise later."}
                    </p>
                  </div>
                </div>
              </>
            )}
            {failure && <p role="alert" className="text-compact text-orb-coral">{failure}</p>}
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-orb-line px-6 py-4">
            <span className="min-w-[14rem] flex-1 text-xs text-orb-muted">
              {host ? `Orbik reads ${host} as OrbikBot and obeys its robots.txt.` : "Orbik reads every source as OrbikBot and obeys its robots.txt."}
            </span>
            <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!ready || pending}>{pending ? "Adding…" : "Add and read now"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** What the check found about the address, in one line under it. */
function AddressFinding({ id, check, checking, error }) {
  if (checking) return <p id={id} className="text-compact text-orb-muted">Looking at the address…</p>;
  if (error) return <p id={id} role="alert" className="text-compact text-orb-coral">{error}</p>;
  if (!check) return <p id={id} className="text-compact text-orb-muted">A site, a section of one, or a single page.</p>;
  if (!check.websiteSetUp) return <Finding id={id} tone="orange">Set up the website’s crawl first: every other source sits beside it.</Finding>;
  if (check.full) return <Finding id={id} tone="orange">This workspace has as many sources as it can have. Remove one to add another.</Finding>;
  if (check.conflict) {
    return (
      <Finding id={id} tone="orange">
        {check.conflict.primary
          ? `${check.host} is your website’s own host, and the website reads all of it already.`
          : `${check.conflict.name} already reads ${check.host}. Add the page there instead.`}
      </Finding>
    );
  }
  if (check.known && !check.known.readable) return <Finding id={id} tone="coral">{check.known.reason}</Finding>;
  const page = check.page;
  if (page.robotsAllowed === false) return <Finding id={id} tone="orange">{check.host}’s robots.txt asks crawlers not to read this page, so Orbik would read nothing here.</Finding>;
  if (page.error) return <Finding id={id} tone="orange">{page.error.message} Orbik will try when it reads it.</Finding>;
  if (page.status === 401 || page.status === 403) {
    return <Finding id={id} tone="orange">{check.host} answered {page.status}: it may refuse OrbikBot. If it does, the source shows why, and the site’s owner can let OrbikBot in.</Finding>;
  }
  if (page.status >= 400) return <Finding id={id} tone="orange">The page answered {page.status}. Check the address.</Finding>;
  return (
    <p id={id} className="flex items-center gap-1.5 text-compact text-orb-gray">
      <Check aria-hidden="true" className="size-3.5 shrink-0 text-orb-lime" />
      {page.title ? <>Page found: “{page.title}”</> : "Page found."}
      {check.known && <span className="text-orb-muted">· {check.known.label}</span>}
    </p>
  );
}

function Finding({ id, tone, children }) {
  return (
    <p id={id} role="alert" className={cn("flex items-start gap-1.5 text-compact", tone === "coral" ? "text-orb-coral" : "text-orb-orange")}>
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** A note under the choice: cyan says why a choice was suggested, orange what a choice costs. */
function Note({ tone, role, children }) {
  return (
    <p role={role} className={cn(
      "flex items-start gap-2 rounded-xl border px-3 py-2.5 text-compact leading-[18px] text-orb-gray",
      tone === "orange" ? "border-orb-orange/40 bg-orb-orange/8" : "border-orb-cyan/30 bg-orb-cyan/6",
    )}>
      {tone === "orange"
        ? <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-orb-orange" />
        : <Info aria-hidden="true" className="size-4 shrink-0 text-orb-cyan" />}
      <span>{children}</span>
    </p>
  );
}

/** One of the two kinds of source, drawn as a card that is pressed. */
function KindCard({ icon: Icon, checked, onPick, title, detail }) {
  return (
    <label className={cn(
      "flex cursor-pointer items-start gap-2.5 rounded-xl border px-3.5 py-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-orb-lime/70",
      checked ? "border-orb-lime/50 bg-orb-lime/6" : "border-orb-line hover:border-orb-muted",
    )}>
      <input type="radio" name="add-source-kind" className="sr-only" checked={checked} onChange={onPick} />
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", checked ? "text-orb-lime" : "text-orb-muted")} />
      <span>
        <span className="block text-sm font-medium text-orb-white">{title}</span>
        <span className="mt-0.5 block text-compact leading-[18px] text-orb-muted">{detail}</span>
      </span>
    </label>
  );
}
