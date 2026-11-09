"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useSWRConfig } from "swr";

import { CalendarClock, CircleSlash, ShieldCheck } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { NeutralLoading } from "@/components/NeutralLoading";
import { acceptInvite, describeMemberError, readInvite } from "@/lib/api/members";
import { WORKSPACES_PATH } from "@/lib/api/workspaces";
import { useAuth } from "@/lib/auth/AuthProvider";
import { formatDate } from "@/lib/format";
import { workspaceHomePath } from "@/lib/workspaces/home";
import { cn } from "@/lib/utils";
import { roleLabel } from "@/lib/workspaces/roles";
import { AUTH_LINK, AuthError, AuthField, AuthPanel, AuthPanelFoot } from "./AuthFrame";

/** What an invite that no longer works says, by why. */
const GONE = Object.freeze({
  expired: { title: "This invite has expired", body: "Invites work for seven days. Ask whoever invited you for a new link." },
  accepted: { title: "This invite has already been used", body: "An invite link works once. If it was you, sign in and the workspace is in your list; otherwise ask for a new link." },
  revoked: { title: "This invite was withdrawn", body: "Whoever invited you took it back. Ask them for a new link if you still need access." },
});

/** The 410 refusals of accepting, as the status the page shows for them. */
const GONE_CODES = Object.freeze({ INVITE_EXPIRED: "expired", INVITE_USED: "accepted", INVITE_REVOKED: "revoked" });

/** What the API asks of a new password: seed:user's rule, 8 to 1024 characters. */
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 1024;

/**
 * An invite link, opened.
 *
 * It says which workspace, for which address, as which role and from whom, and then offers the one
 * step that fits who has opened it:
 *
 * - signed in with the invited address: accept, and land in the workspace;
 * - signed in with another address: that the invite is not theirs, and a way to sign out;
 * - not signed in, the address has an account: sign in, which comes back here, then accept;
 * - not signed in, no account: choose a password, which creates the account and accepts.
 *
 * An invite that has expired, been used or been withdrawn says so and offers nothing; an address
 * that names no invite at all says the link is not valid.
 */
export function InviteAcceptance() {
  const { token } = useParams();
  const auth = useAuth();
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const [invite, setInvite] = useState(null);
  const [failure, setFailure] = useState(null);
  const [gone, setGone] = useState(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [passwordError, setPasswordError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const described = await readInvite(token);
        if (!cancelled) setInvite(described.invite);
      } catch (caught) {
        if (!cancelled) setFailure(caught);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  /**
   * Accepts, then goes to the workspace. The session and the workspace list are read again first:
   * accepting can have created and signed in an account, and the list now holds one more workspace.
   *
   * Should that session read fail, the account and the membership exist all the same and the
   * browser holds the new session's cookie, so the workspace is loaded afresh rather than through
   * the router: a full load reads the session itself, where the router would find the app still
   * thinking nobody is signed in and send them to sign in.
   */
  const accept = useCallback(async (body) => {
    setWorking(true);
    setFailure(null);
    try {
      const result = await acceptInvite(token, body);
      const home = workspaceHomePath(result.workspaceId);
      const session = await auth.refresh();
      if (!session?.authenticated) {
        window.location.assign(home);
        return;
      }
      await mutate(WORKSPACES_PATH);
      router.replace(home);
    } catch (caught) {
      if (GONE_CODES[caught?.code]) setGone(GONE_CODES[caught.code]);
      else if (caught?.code === "AUTHENTICATION_REQUIRED") {
        // The address has an account after all — made since this page was opened — so the way in
        // is signing in, not choosing a password.
        setInvite((current) => (current ? { ...current, accountExists: true } : current));
        setPassword("");
        setConfirm("");
      } else if (caught?.code === "VALIDATION_FAILED" && body?.password !== undefined) setPasswordError(describeMemberError(caught));
      else setFailure(caught);
      setWorking(false);
    }
  }, [auth, mutate, router, token]);

  function createAccount(event) {
    event.preventDefault();
    setPasswordError(null);
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      setPasswordError(`Choose a password of ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`);
      return;
    }
    if (password !== confirm) {
      setPasswordError("The two passwords are not the same.");
      return;
    }
    accept({ password });
  }

  async function signOut() {
    setWorking(true);
    try {
      await auth.signOut();
    } finally {
      setWorking(false);
    }
  }

  if (loading || auth.status === "loading") return <NeutralLoading inline label="Loading the invite" />;

  if (!invite) {
    const notFound = failure?.status === 404 || failure?.code === "INVITE_NOT_FOUND" || !token;
    return (
      <Notice
        title={notFound ? "This invite link is not valid" : "This invite could not be loaded"}
        body={notFound
          ? "Check that the whole link was copied. If it was, ask whoever invited you for a new one."
          : describeMemberError(failure, "Try again in a moment.")}
      />
    );
  }

  const status = gone ?? (invite.status === "pending" ? null : invite.status);
  if (status) {
    const text = GONE[status] ?? GONE.expired;
    return <Notice title={text.title} body={text.body} workspace={invite.workspace?.name} />;
  }

  const signedIn = auth.status === "authenticated";
  const mine = signedIn && sameAddress(auth.user?.email, invite.email);
  const loginHref = `/login?next=${encodeURIComponent(`/invite/${token}`)}`;
  const error = failure ? describeMemberError(failure) : null;

  return (
    <AuthPanel
      size="lg"
      data-testid="invite-card"
      eyebrow={<WorkspaceMark name={invite.workspace.name} />}
      title={`Join ${invite.workspace.name}`}
      description={
        <>
          {invite.invitedBy?.email
            ? <><span className="[overflow-wrap:anywhere] text-orb-white">{invite.invitedBy.email}</span> invited </>
            : "An invite for "}
          <span className="[overflow-wrap:anywhere] text-orb-white">{invite.email}</span> to join as{" "}
          <span className="font-medium text-orb-white">{roleLabel(invite.role) ?? invite.role}</span>.
          {invite.expiresAt && <> The link works until {formatDate(invite.expiresAt, { time: false })}.</>}
        </>
      }
    >
      <div className="space-y-5">
        <div className="flex gap-3 rounded-lg border border-orb-line bg-orb-space/50 px-3.5 py-3">
          <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-orb-lime" />
          <div className="min-w-0 space-y-1.5">
            <Pill tone={invite.role === "admin" ? "cyan" : "neutral"}>{roleLabel(invite.role) ?? invite.role}</Pill>
            <p className="text-sm text-orb-gray">{describeRole(invite.role)}</p>
          </div>
        </div>

        {error && <AuthError>{error}</AuthError>}

        {mine ? (
          <Button type="button" className="h-10 w-full" onClick={() => accept(undefined)} disabled={working} data-testid="invite-accept">
            {working ? "Joining…" : `Accept and open ${invite.workspace.name}`}
          </Button>
        ) : signedIn ? (
          <div className="space-y-3" data-testid="invite-other-address">
            <p className="text-sm text-orb-white">
              You are signed in as <span className="[overflow-wrap:anywhere] font-medium">{auth.user?.email}</span>, but this invite is for{" "}
              <span className="[overflow-wrap:anywhere] font-medium">{invite.email}</span>. Sign out, then open the link again as that address.
            </p>
            <Button type="button" variant="outline" onClick={signOut} disabled={working}>
              {working ? "Signing out…" : "Sign out"}
            </Button>
          </div>
        ) : invite.accountExists ? (
          <div className="space-y-4" data-testid="invite-sign-in">
            <p className="text-sm text-orb-white">
              <span className="[overflow-wrap:anywhere] font-medium">{invite.email}</span> already has an Orbik account. Sign in with it, and you
              come back here to accept.
            </p>
            <Link href={loginHref} className={cn(buttonVariants({ size: "lg" }), "h-10 w-full")}>
              Sign in to accept
            </Link>
          </div>
        ) : (
          <form onSubmit={createAccount} noValidate className="space-y-5" data-testid="invite-create-account">
            <p className="text-sm text-orb-white">
              Choose a password for <span className="[overflow-wrap:anywhere] font-medium">{invite.email}</span>. This creates your Orbik account
              and joins the workspace; you sign in with that address and this password from now on.
            </p>
            {passwordError && <AuthError>{passwordError}</AuthError>}
            <AuthField htmlFor="invite-password" label="Password" hint={`At least ${PASSWORD_MIN} characters.`}>
              <Input
                id="invite-password"
                type="password"
                autoComplete="new-password"
                value={password}
                maxLength={PASSWORD_MAX}
                onChange={(event) => setPassword(event.target.value)}
              />
            </AuthField>
            <AuthField htmlFor="invite-password-confirm" label="The same password again">
              <Input
                id="invite-password-confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                maxLength={PASSWORD_MAX}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </AuthField>
            <Button type="submit" className="h-10 w-full" disabled={working || !password || !confirm}>
              {working ? "Creating your account…" : "Create account and join"}
            </Button>
          </form>
        )}
      </div>
    </AuthPanel>
  );
}

/** The workspace's initial in a lime tile, as Home's header draws it. */
function WorkspaceMark({ name }) {
  const initial = String(name ?? "").match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? "·";
  return (
    <span
      aria-hidden="true"
      className="flex size-11 items-center justify-center rounded-xl bg-orb-lime font-display text-lg font-bold text-orb-black shadow-[0_0_0_4px_color-mix(in_oklab,var(--color-orb-lime)_14%,transparent)]"
    >
      {initial}
    </span>
  );
}

/** A page with one thing to say and nothing to do. */
function Notice({ title, body, workspace }) {
  const Icon = workspace ? CalendarClock : CircleSlash;
  return (
    <AuthPanel
      size="lg"
      data-testid="invite-notice"
      eyebrow={
        <span
          aria-hidden="true"
          className={cn(
            "flex size-11 items-center justify-center rounded-xl border",
            workspace ? "border-orb-orange/40 bg-orb-orange/10 text-orb-orange" : "border-orb-coral/40 bg-orb-coral/10 text-orb-coral",
          )}
        >
          <Icon className="size-5" />
        </span>
      }
      title={title}
      description={workspace ? <>The invite was to <span className="text-orb-white">{workspace}</span>.</> : null}
    >
      <p className="text-sm text-orb-gray">{body}</p>
      <AuthPanelFoot><Link href="/login" className={AUTH_LINK}>Go to sign in</Link></AuthPanelFoot>
    </AuthPanel>
  );
}

/** What joining as a role will let somebody do, in a sentence. */
function describeRole(role) {
  if (role === "admin") return "As an admin you can read and edit everything in the workspace, crawl, run agents, and invite and manage its members.";
  if (role === "member") return "As a member you can read and edit the Library, crawl the site, and set agents to work.";
  return "As a read-only member you can read the Library, the crawled pages and the brand, and ask questions of them.";
}

/** Whether two addresses are one, as the API canonicalises them: trimmed and lower-cased. */
function sameAddress(left, right) {
  return Boolean(left && right) && left.trim().normalize("NFC").toLowerCase() === right.trim().normalize("NFC").toLowerCase();
}
