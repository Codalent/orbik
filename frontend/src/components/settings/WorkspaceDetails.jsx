"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Pencil, Trash2 } from "lucide-react";
import { useSWRConfig } from "swr";

import { CopyButton } from "@/components/brand/CopyButton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Panel, PanelTitle } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { useAuth } from "@/lib/auth/AuthProvider";
import { WORKSPACES_PATH, deleteWorkspace, listWorkspaces, updateWorkspace } from "@/lib/api/workspaces";
import { formatDate, hostOf } from "@/lib/format";
import { cn } from "@/lib/utils";
import { workspaceHomePath } from "@/lib/workspaces/home";
import { can, roleLabel, roleOf } from "@/lib/workspaces/roles";

/**
 * What the workspace is — its name, site, identifier, the reader's role, when it was made — and,
 * for admins and the owner, editing the name and website. Deleting it is `DeleteWorkspace` below,
 * which the settings page puts last, after every other section, so it is not the second thing on
 * the page.
 *
 * Everything shown is the workspace list's item (`GET /v1/workspaces`), the same read the shell's
 * switcher and header use, so a save re-reads that list and every one of them follows.
 *
 * A website on another hostname is another site, and the API will not move to one until the person
 * has said yes to what it does to the crawl; that question is asked here, in a dialog, only when the
 * API asks it. The API decides everything; what is hidden here is only what it would refuse.
 *
 * @param {object} props
 * @param {object} props.workspace an item of `GET /v1/workspaces`
 */
export function WorkspaceDetails({ workspace }) {
  const role = roleOf(workspace);
  const canEdit = can(role, "admin");
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState(null);

  return (
    <Panel className="p-0 sm:p-0">
      {editing ? (
        <DetailsForm
          workspace={workspace}
          onDone={(message) => { setEditing(false); setNotice(message); }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <dl className="divide-y divide-orb-line/70">
            <Fact label="Name">
              <span className="text-orb-white">{workspace.name}</span>
            </Fact>
            <Fact label="Website">
              {workspace.websiteUrl ? (
                <a href={workspace.websiteUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 break-all text-orb-white underline-offset-4 hover:underline">
                  {workspace.websiteUrl}
                  <ArrowUpRight aria-hidden="true" className="size-3.5 shrink-0 text-orb-muted" />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              ) : (
                <span className="text-orb-muted">Not set</span>
              )}
            </Fact>
            <Fact label="Workspace ID" hint="An AI connected to several workspaces names this one by it.">
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <code className="break-all rounded-md border border-orb-line bg-orb-space/70 px-2 py-0.5 font-mono text-xs text-orb-white">{workspace.id}</code>
                <CopyButton text={workspace.id} label="Copy" />
              </span>
            </Fact>
            <Fact label="Your role">
              <Pill tone={role === "owner" ? "lime" : role === "admin" ? "cyan" : "neutral"}>{roleLabel(role) ?? role}</Pill>
            </Fact>
            {workspace.createdAt && (
              <Fact label="Created">
                <span className="text-orb-white">{formatDate(workspace.createdAt, { time: false })}</span>
              </Fact>
            )}
          </dl>
          {canEdit && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-orb-line/70 px-4 py-3 sm:px-5">
              <p role={notice ? "status" : undefined} className={cn("min-w-[11rem] flex-1 text-xs", notice ? "text-orb-lime" : "text-orb-muted")}>
                {notice ?? "Admins and the owner can rename the workspace and change its website."}
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => { setNotice(null); setEditing(true); }} data-testid="workspace-edit">
                <Pencil aria-hidden="true" />
                Edit name and website
              </Button>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

/**
 * The name and website as fields, saved through `PATCH /v1/workspaces/:id`. Only what changed is
 * sent. A website on another hostname comes back as `409 SITE_CHANGE_UNCONFIRMED`, which opens the
 * dialog that says what moving to another site does; saying yes sends the same change confirmed.
 */
function DetailsForm({ workspace, onDone, onCancel }) {
  const { mutate } = useSWRConfig();
  const [name, setName] = useState(workspace.name);
  const [websiteUrl, setWebsiteUrl] = useState(workspace.websiteUrl ?? "");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState(null);
  const [siteChange, setSiteChange] = useState(null);

  const changes = {
    ...(name.trim() !== workspace.name ? { name } : {}),
    ...(websiteUrl.trim() !== (workspace.websiteUrl ?? "") ? { websiteUrl: websiteUrl.trim() } : {}),
  };
  const changed = Object.keys(changes).length > 0;

  async function save({ confirmSiteChange = false } = {}) {
    setPending(true);
    setFailure(null);
    try {
      const result = await updateWorkspace(workspace.id, changes, { confirmSiteChange });
      await mutate(WORKSPACES_PATH);
      setSiteChange(null);
      onDone(savedMessage(result));
    } catch (problem) {
      if (problem?.code === "SITE_CHANGE_UNCONFIRMED") {
        setSiteChange({ message: problem.message, to: changes.websiteUrl });
      } else {
        setSiteChange(null);
        setFailure(problem);
      }
    } finally {
      setPending(false);
    }
  }

  function submit(event) {
    event.preventDefault();
    if (changed && !pending) save();
  }

  const nameError = failure?.fieldMessage?.("name");
  const websiteError = failure?.fieldMessage?.("websiteUrl");
  const otherError = failure && !nameError && !websiteError ? failure.message : null;

  return (
    <form onSubmit={submit} noValidate data-testid="workspace-edit-form">
      <dl className="divide-y divide-orb-line/70">
        <Fact label="Name" htmlFor="workspace-name">
          <Input id="workspace-name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} aria-invalid={Boolean(nameError)} aria-describedby={nameError ? "workspace-name-error" : undefined} autoComplete="off" />
          {nameError && <p id="workspace-name-error" className="mt-1 text-xs text-orb-coral">{nameError}</p>}
        </Fact>
        <Fact label="Website" htmlFor="workspace-website" hint="The site this workspace is about. Crawls start here.">
          <Input id="workspace-website" type="url" inputMode="url" value={websiteUrl} onChange={(event) => setWebsiteUrl(event.target.value)} aria-invalid={Boolean(websiteError)} aria-describedby={websiteError ? "workspace-website-error" : "workspace-website-hint"} autoComplete="off" />
          {websiteError
            ? <p id="workspace-website-error" className="mt-1 text-xs text-orb-coral">{websiteError}</p>
            : <p id="workspace-website-hint" className="mt-1 text-xs text-orb-muted">The same site at a new address keeps everything crawled. A different site starts over: you are asked first.</p>}
        </Fact>
      </dl>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-orb-line/70 px-4 py-3 sm:px-5">
        {otherError && <span role="alert" className="min-w-[11rem] flex-1 text-xs text-orb-coral">{otherError}</span>}
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={pending}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!changed || pending}>{pending && !siteChange ? "Saving…" : "Save"}</Button>
      </div>

      {siteChange && (
        <Dialog open onOpenChange={(open) => { if (!open && !pending) setSiteChange(null); }}>
          <DialogContent className="max-w-130">
            <div className="px-6 pt-4.5 pb-1.5 pr-14">
              <DialogTitle className="font-sans text-base leading-6 text-orb-white">Move this workspace to {hostOf(siteChange.to)}?</DialogTitle>
              <DialogDescription className="mt-1 text-sm text-orb-gray">{siteChange.message}</DialogDescription>
            </div>
            <ul className="list-disc space-y-1 px-6 pt-2.5 pb-5 pl-11 text-sm text-orb-gray">
              <li>Every page crawled from the old site is removed: snapshots, links, page Markdown and crawl history.</li>
              <li>A crawl of {hostOf(siteChange.to)} starts within a minute and spends this month&apos;s crawl budget.</li>
              <li>The Library keeps what people and agents wrote; its copies of the old pages are replaced as the new pages are crawled.</li>
              <li>The brand stays as it is.</li>
            </ul>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-orb-line py-3.5 pr-4 pl-6">
              <Button type="button" variant="ghost" onClick={() => setSiteChange(null)} disabled={pending}>Keep the current site</Button>
              <Button type="button" variant="destructive" onClick={() => save({ confirmSiteChange: true })} disabled={pending} data-testid="workspace-site-change-confirm">
                {pending ? "Changing…" : "Change the website"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </form>
  );
}

/** What a save did, in one sentence, from the API's account of the crawl. */
function savedMessage({ crawl }) {
  switch (crawl?.change) {
    case "seed-moved": return "Saved. The next crawl starts from the new address and keeps everything crawled so far.";
    case "seed-kept": return `Saved. Crawls still start from ${crawl.seedUrl}, the start page chosen on the Crawl page.`;
    case "new-site": return `Saved. ${crawl.pagesCleared.toLocaleString()} ${crawl.pagesCleared === 1 ? "page" : "pages"} of the old site removed; a crawl of the new site starts within a minute.`;
    case "not-set-up": return "Saved. The Crawl page will start from the new address when crawling is set up.";
    default: return "Saved.";
  }
}

/**
 * The owner's way to delete the workspace: a panel that says exactly what goes, and a dialog in
 * which the workspace's name is typed out before the button that does it can be pressed. After the
 * deletion the person goes where leaving a workspace takes them: the workspace the API's list now
 * selects, or making a new one. Shown to the owner only; the caller decides that and where it goes.
 */
export function DeleteWorkspace({ workspace }) {
  const router = useRouter();
  const auth = useAuth();
  const { mutate } = useSWRConfig();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState(null);
  const matches = typed.trim() === workspace.name;

  function close() {
    if (pending) return;
    setOpen(false);
    setTyped("");
    setFailure(null);
  }

  async function remove(event) {
    event.preventDefault();
    if (!matches || pending) return;
    setPending(true);
    setFailure(null);
    try {
      await deleteWorkspace(workspace.id, typed);
      const next = await listWorkspaces();
      await mutate(WORKSPACES_PATH, next, { revalidate: false });
      await auth.refresh();
      router.replace(next.selectedWorkspaceId ? workspaceHomePath(next.selectedWorkspaceId) : "/workspaces/new");
    } catch (problem) {
      setFailure(problem?.message ?? "The workspace could not be deleted. Try again.");
      setPending(false);
    }
  }

  return (
    <Panel className="border-orb-coral/40 bg-orb-coral/5" data-testid="workspace-danger">
      <PanelTitle>Delete this workspace</PanelTitle>
      <p className="text-sm text-orb-gray">
        Deleting {workspace.name} removes everything in it, for everyone in it, at once. It cannot be undone.
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-orb-gray">
        <li>Every crawled page, the Library, the search index, llms.txt, chats and agent runs.</li>
        <li>The brand and the files uploaded to it.</li>
        <li>Its members and open invites. AI tokens and apps that read only this workspace stop working; ones that read others keep those.</li>
      </ul>
      <p className="mt-2 text-xs text-orb-muted">Pages already fetched this month still count against your crawl budget. Stop anything running first: a workspace with a crawl or an agent at work cannot be deleted.</p>
      <div className="mt-3">
        <Button type="button" variant="destructive" size="sm" onClick={() => setOpen(true)} data-testid="workspace-delete">
          <Trash2 aria-hidden="true" />
          Delete workspace…
        </Button>
      </div>

      {open && (
        <Dialog open onOpenChange={(next) => { if (!next) close(); }}>
          <DialogContent className="max-w-130">
            <form onSubmit={remove}>
              <div className="px-6 pt-4.5 pb-1.5 pr-14">
                <DialogTitle className="font-sans text-base leading-6 text-orb-white">Delete {workspace.name}?</DialogTitle>
                <DialogDescription className="mt-1 text-sm text-orb-gray">
                  Everything in it goes for everyone, now and for good. Type <strong className="font-semibold text-orb-white">{workspace.name}</strong> to confirm.
                </DialogDescription>
              </div>
              <div className="px-6 pt-2.5 pb-5">
                <label htmlFor="workspace-delete-name" className="sr-only">Workspace name</label>
                <Input id="workspace-delete-name" value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" spellCheck={false} placeholder={workspace.name} disabled={pending} data-testid="workspace-delete-name" />
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-orb-line py-3.5 pr-4 pl-6">
                {failure && <span role="alert" className="min-w-[11rem] flex-1 text-xs text-orb-coral">{failure}</span>}
                <Button type="button" variant="ghost" onClick={close} disabled={pending}>Cancel</Button>
                <Button type="submit" variant="destructive" disabled={!matches || pending} data-testid="workspace-delete-confirm">
                  {pending ? "Deleting…" : "Delete workspace"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </Panel>
  );
}

/** One line of the workspace's details: a label (with a hint under it) and its value. */
function Fact({ label, hint, htmlFor, children }) {
  const Label = htmlFor ? "label" : "span";
  return (
    <div className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[13rem_minmax(0,1fr)] sm:items-center sm:gap-4 sm:px-5">
      <dt>
        <Label htmlFor={htmlFor} className="text-orb-gray">{label}</Label>
        {hint && <span className="mt-0.5 block text-xs text-orb-muted">{hint}</span>}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}
