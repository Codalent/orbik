"use client";

import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { ArrowLeft, Check, Copy, Inbox, KeyRound, ShieldCheck, X } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader, SectionHeading } from "@/components/ui/page-header";
import { EmptyState, Panel, PanelTitle, RowList } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { NeutralLoading } from "@/components/NeutralLoading";
import {
  approveAccessRequest,
  createPasswordResetLink,
  describeAccessError,
  dismissAccessRequest,
  accessRequestsPath,
} from "@/lib/api/access";
import { useAuth } from "@/lib/auth/AuthProvider";
import { formatDate } from "@/lib/format";

const STATUS = {
  pending: { tone: "orange", label: "Waiting" },
  approved: { tone: "cyan", label: "Approved" },
  joined: { tone: "lime", label: "Joined" },
  dismissed: { tone: "muted", label: "Dismissed" },
};

const FILTERS = [
  { value: "pending", label: "Waiting" },
  { value: "", label: "All" },
];

/**
 * The install's Admin page: who asked for access on the closed signup page, and a password reset
 * link for someone who cannot get one by email. Only the install's admins (`ORBIK_ADMIN_EMAILS`,
 * or the install's first account) can open it; the API answers anyone else as if it were not here.
 */
export function AdminPage() {
  const auth = useAuth();
  const [filter, setFilter] = useState("pending");
  const { data, error: loadError, mutate } = useSWR(auth.user?.isAdmin ? accessRequestsPath({ status: filter || undefined }) : null);
  const [actionError, setError] = useState(null);
  const error = actionError ?? loadError;
  const [busyId, setBusyId] = useState(null);
  // The one link just made, shown once so the admin can send it.
  const [issued, setIssued] = useState(null);
  const load = () => mutate();

  async function act(row, action) {
    setBusyId(row.id);
    setError(null);
    try {
      if (action === "approve") {
        const result = await approveAccessRequest(row.id);
        setIssued({ kind: "access", email: row.email, url: result.url, emailed: result.emailed });
      } else {
        await dismissAccessRequest(row.id);
      }
      await load();
    } catch (caught) {
      setError(caught);
      if (caught?.code === "ACCOUNT_EXISTS") await load();
    } finally {
      setBusyId(null);
    }
  }

  if (auth.user && !auth.user.isAdmin) {
    return (
      <Frame>
        <EmptyState icon={ShieldCheck}>Only this Orbik&apos;s admins can open this page.</EmptyState>
      </Frame>
    );
  }
  if (!data && !error) return <NeutralLoading label="Loading Admin" />;

  return (
    <Frame>
      <PageHeader
        icon={ShieldCheck}
        title="Admin"
        description="People asking to join this Orbik, and password resets for people who can't get one by email."
        status={data?.pending ? <Pill tone="orange" dot>{data.pending} waiting</Pill> : null}
      />

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{describeAccessError(error)}</AlertDescription>
        </Alert>
      )}

      {issued && <IssuedLink issued={issued} onClose={() => setIssued(null)} />}

      <section aria-labelledby="access-requests" className="flex flex-col gap-3">
        <SectionHeading
          id="access-requests"
          aside={data?.emailConfigured ? "Approving emails the person a link to create their account." : "This Orbik sends no email: approving gives you a link to send them."}
          action={(
            <div role="group" aria-label="Show" className="flex gap-1">
              {FILTERS.map((option) => (
                <Button key={option.value || "all"} size="sm" variant={filter === option.value ? "secondary" : "ghost"} aria-pressed={filter === option.value} onClick={() => setFilter(option.value)}>
                  {option.label}
                </Button>
              ))}
            </div>
          )}
        >
          Access requests
        </SectionHeading>
        {data?.requests?.length ? (
          <RowList>
            {data.requests.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-orb-white">{row.email}</span>
                    <Pill tone={STATUS[row.status]?.tone}>{STATUS[row.status]?.label ?? row.status}</Pill>
                  </div>
                  <p className="mt-0.5 text-xs text-orb-muted">
                    Asked {formatDate(row.lastRequestedAt)}
                    {row.requestCount > 1 && ` · ${row.requestCount} times`}
                    {row.decidedBy && row.status !== "pending" && ` · ${STATUS[row.status]?.label.toLowerCase()} by ${row.decidedBy}`}
                    {row.status === "approved" && row.linkExpiresAt && ` · link works until ${formatDate(row.linkExpiresAt)}`}
                  </p>
                </div>
                {row.status !== "joined" && (
                  <div className="flex shrink-0 gap-2">
                    <Button size="sm" disabled={busyId === row.id} onClick={() => act(row, "approve")}>
                      <Check aria-hidden="true" />{row.status === "approved" ? "New link" : "Approve"}
                    </Button>
                    {row.status !== "dismissed" && (
                      <Button size="sm" variant="ghost" disabled={busyId === row.id} onClick={() => act(row, "dismiss")}>
                        <X aria-hidden="true" />Dismiss
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </RowList>
        ) : (
          <EmptyState icon={Inbox}>
            {filter === "pending" ? "Nobody is waiting. Requests from the signup page appear here." : "Nobody has asked for access yet."}
          </EmptyState>
        )}
      </section>

      <ResetLinkPanel onIssued={setIssued} />
    </Frame>
  );
}

function Frame({ children }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 px-4 py-5 sm:px-10 sm:pt-7 sm:pb-10">
      <Link href="/" className="-mb-2 inline-flex min-h-6 items-center gap-1.5 self-start text-xs text-orb-muted hover:text-orb-white">
        <ArrowLeft aria-hidden="true" className="size-3.5" />Back to Orbik
      </Link>
      {children}
    </main>
  );
}

/** A link just made, with a copy button: it is never shown again. */
function IssuedLink({ issued, onClose }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(issued.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  const what = issued.kind === "access" ? "create their account" : "choose a new password";
  return (
    <Panel role="status" className="border-orb-cyan/40">
      <PanelTitle aside={<Button size="sm" variant="ghost" onClick={onClose}>Done</Button>}>
        {issued.kind === "access" ? `Approved ${issued.email}` : `Reset link for ${issued.email}`}
      </PanelTitle>
      <p className="text-sm text-orb-gray">
        {issued.emailed
          ? `We emailed them this link to ${what}. You can also send it yourself.`
          : `Send them this link to ${what}. It works once, and is shown only now.`}
      </p>
      <div className="mt-3 flex gap-2">
        <Input readOnly value={issued.url} aria-label="Link" className="font-mono text-xs" onFocus={(event) => event.target.select()} />
        <Button variant="secondary" onClick={copy}><Copy aria-hidden="true" />{copied ? "Copied" : "Copy"}</Button>
      </div>
    </Panel>
  );
}

/** Makes a password reset link for an account, to hand over. */
function ResetLinkPanel({ onIssued }) {
  const [email, setEmail] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);

  async function submit(event) {
    event.preventDefault();
    setWorking(true);
    setError(null);
    try {
      const result = await createPasswordResetLink({ email: email.trim() });
      onIssued({ kind: "reset", email: result.email, url: result.url, emailed: false });
      setEmail("");
    } catch (caught) {
      setError(caught);
    } finally {
      setWorking(false);
    }
  }

  return (
    <Panel>
      <PanelTitle as="h2">Password reset link</PanelTitle>
      <p className="text-sm text-orb-gray">For someone who forgot their password and can&apos;t get a link by email. It works once, for an hour.</p>
      <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-2">
        <div className="min-w-56 flex-1 space-y-2">
          <Label htmlFor="reset-for" className="text-orb-white">Their email</Label>
          <Input id="reset-for" type="email" autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </div>
        <Button type="submit" variant="secondary" disabled={working || !email.trim()}>
          <KeyRound aria-hidden="true" />{working ? "Making…" : "Make link"}
        </Button>
      </form>
      {error && <p role="alert" className="mt-2 text-xs text-orb-coral">{describeAccessError(error)}</p>}
    </Panel>
  );
}
