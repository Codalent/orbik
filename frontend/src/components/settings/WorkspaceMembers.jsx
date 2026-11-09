"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, LogOut, Mail, UserMinus } from "lucide-react";
import useSWR, { useSWRConfig } from "swr";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyButton } from "@/components/brand/CopyButton";
import { Avatar } from "@/components/ui/avatar";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Panel, PanelTitle, RowList } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/lib/auth/AuthProvider";
import { formatDate } from "@/lib/format";
import * as membersApi from "@/lib/api/members";
import { WORKSPACES_PATH, listWorkspaces } from "@/lib/api/workspaces";
import { workspaceHomePath } from "@/lib/workspaces/home";
import { MEMBER_ROLES, ROLE_LABELS, can, roleLabel } from "@/lib/workspaces/roles";
import { MembersSkeleton } from "./SettingsSkeletons";

/** The roles a member can be given, as the role pickers' items: value to label. */
const ROLE_ITEMS = Object.fromEntries(MEMBER_ROLES.map((value) => [value, ROLE_LABELS[value]]));

/**
 * Who is in this workspace, as what, and — for its admins and its owner — how people are added.
 *
 * Everybody in the workspace sees the list. Admins and the owner also invite people, see and
 * withdraw the invites still open, change a member's role and take a member out; nobody changes or
 * removes the owner, so the owner's row has no controls. Everybody but the owner can leave.
 *
 * An invite is a link, shown once, which the person who made it sends themselves: nothing is
 * emailed. The link works once, for seven days, and only for the address it was made for.
 *
 * The API is what enforces all of this; what is hidden here is only what would be refused.
 *
 * @param {object} props
 * @param {string} props.workspaceId
 */
export function WorkspaceMembers({ workspaceId }) {
  const router = useRouter();
  const auth = useAuth();
  const { mutate: mutateCache } = useSWRConfig();
  const membersRead = useSWR(membersApi.membersPath(workspaceId));
  const role = membersRead.data?.role ?? null;
  const canManage = can(role, "admin");
  const invitesRead = useSWR(canManage ? membersApi.invitesPath(workspaceId) : null);

  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [issued, setIssued] = useState(null);
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [confirm, confirmDialog] = useConfirm();

  const members = membersRead.data?.members ?? [];
  const invites = invitesRead.data?.invites ?? [];
  const maxMembers = membersRead.data?.limits?.maxMembers ?? null;

  /** Shows a refusal as a sentence, and re-reads what the refusal may have been about. */
  function report(failure) {
    setActionError(membersApi.describeMemberError(failure));
  }

  /** Re-reads the list, and the workspace list when the change could have been to the caller's own role. */
  async function reread({ own = false } = {}) {
    // After a change to the caller's own role the invites are not re-read here: the members read
    // says whether they may still see them, and asking first would only be refused.
    await Promise.all([
      membersRead.mutate(),
      canManage && !own ? invitesRead.mutate() : null,
      own ? mutateCache(WORKSPACES_PATH) : null,
    ]);
  }

  async function invite(event) {
    event.preventDefault();
    const address = email.trim();
    if (!address) return;
    setInviting(true);
    setActionError(null);
    try {
      const result = await membersApi.inviteMember(workspaceId, { email: address, role: inviteRole });
      setIssued(result);
      setEmail("");
      setInviteRole("member");
      await invitesRead.mutate();
    } catch (failure) {
      report(failure);
    } finally {
      setInviting(false);
    }
  }

  async function revoke(inviteId) {
    setBusy(inviteId);
    setActionError(null);
    try {
      await membersApi.revokeInvite(workspaceId, inviteId);
      await invitesRead.mutate();
    } catch (failure) {
      report(failure);
    } finally {
      setBusy(null);
    }
  }

  async function changeRole(member, next) {
    if (next === member.role) return;
    // An admin who lowers their own role loses what lets them undo it, so they are asked first.
    if (member.isYou && !(await confirm({
      title: `Change your own role to ${ROLE_LABELS[next]}?`,
      description: next === "admin" ? null : "You will no longer be able to manage members, and only an admin or the owner can give the role back.",
      confirmLabel: `Change to ${ROLE_LABELS[next]}`,
      destructive: next !== "admin",
    }))) return;
    setBusy(member.userId);
    setActionError(null);
    try {
      await membersApi.changeMemberRole(workspaceId, member.userId, next);
      await reread({ own: member.isYou });
    } catch (failure) {
      report(failure);
      await membersRead.mutate();
    } finally {
      setBusy(null);
    }
  }

  async function remove(member) {
    if (!(await confirm({
      title: `Remove ${member.email} from this workspace?`,
      description: "They lose access at once; an invite brings them back.",
      confirmLabel: "Remove",
      destructive: true,
    }))) return;
    setBusy(member.userId);
    setActionError(null);
    try {
      await membersApi.removeMember(workspaceId, member.userId);
      await reread();
    } catch (failure) {
      report(failure);
    } finally {
      setBusy(null);
    }
  }

  /**
   * Leaves the workspace, then goes to whichever workspace the person still has — the API's list
   * repairs the selection — or to making one when there is none.
   */
  async function leave() {
    if (!(await confirm({
      title: "Leave this workspace?",
      description: "You lose access at once; only an admin or the owner can invite you back.",
      confirmLabel: "Leave workspace",
      destructive: true,
    }))) return;
    setBusy("leave");
    setActionError(null);
    try {
      await membersApi.leaveWorkspace(workspaceId);
      const next = await listWorkspaces();
      await mutateCache(WORKSPACES_PATH, next, { revalidate: false });
      await auth.refresh();
      router.replace(next.selectedWorkspaceId ? workspaceHomePath(next.selectedWorkspaceId) : "/workspaces/new");
    } catch (failure) {
      report(failure);
      setBusy(null);
    }
  }

  // The role guide does not depend on the read, so it is drawn already; only the list waits.
  if (!membersRead.data && !membersRead.error) {
    return (
      <div className="space-y-4">
        <MembersSkeleton />
        <RoleGuide />
      </div>
    );
  }

  const error = actionError ?? (!membersRead.data ? membersApi.describeMemberError(membersRead.error, "The members could not be loaded.") : null);

  return (
    <div className="space-y-4" data-testid="workspace-members">
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Panel>
        <PanelTitle
          aside={maxMembers !== null && (
            <span className="text-xs text-orb-muted">
              Up to {maxMembers.toLocaleString()} {maxMembers === 1 ? "member" : "members"} besides the owner
            </span>
          )}
        >
          {members.length ? `${members.length.toLocaleString()} ${members.length === 1 ? "person" : "people"}` : "People"}
          {role && <span className="sr-only" data-testid="your-role"> · Your role: {roleLabel(role)}</span>}
        </PanelTitle>

        {members.length > 0 && (
          <RowList aria-label="People in this workspace">
            {members.map((member) => {
              const owner = member.role === "owner";
              const manageable = canManage && !owner;
              return (
                <li key={member.userId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-sm sm:px-4" data-testid="member-row">
                  <Avatar email={member.email} />
                  <span className="min-w-[11rem] flex-1">
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="break-all text-orb-white">{member.email}</span>
                      {member.isYou && <Pill tone="muted">you</Pill>}
                    </span>
                    <span className="block text-xs text-orb-muted">
                      {owner ? "Owner since" : "Joined"} {formatDate(member.joinedAt, { time: false })}
                    </span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    {manageable ? (
                      <RoleSelect
                        label={`Role of ${member.email}`}
                        value={member.role}
                        disabled={busy !== null}
                        onChange={(next) => changeRole(member, next)}
                      />
                    ) : (
                      <Pill tone={ROLE_TONES[member.role] ?? "neutral"} data-testid="member-role">{roleLabel(member.role) ?? member.role}</Pill>
                    )}
                    {manageable && !member.isYou && (
                      <Button type="button" variant="ghost" size="icon-sm" onClick={() => remove(member)} disabled={busy !== null} title={`Remove ${member.email}`}>
                        <UserMinus aria-hidden="true" className="size-4 text-orb-muted" />
                        <span className="sr-only">Remove {member.email}</span>
                      </Button>
                    )}
                  </span>
                </li>
              );
            })}
            {invites.map((pending) => (
              <li key={pending.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-sm sm:px-4" data-testid="invite-row">
                <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed border-orb-muted/60 text-orb-muted">
                  <Mail className="size-3.5" />
                </span>
                <span className="min-w-[11rem] flex-1">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="break-all text-orb-gray">{pending.email}</span>
                    <Pill tone="orange">Invited</Pill>
                  </span>
                  <span className="block text-xs text-orb-muted">
                    As {roleLabel(pending.role)}
                    {pending.invitedBy?.email ? ` · by ${pending.invitedBy.email}` : ""}
                    {" · "}expires {formatDate(pending.expiresAt, { time: false })}
                  </span>
                </span>
                <Button type="button" variant="ghost" size="sm" onClick={() => revoke(pending.id)} disabled={busy !== null} className="text-orb-muted">
                  {busy === pending.id ? "Withdrawing…" : "Withdraw"}
                </Button>
              </li>
            ))}
          </RowList>
        )}
      </Panel>

      {canManage && (
        <Panel>
          {issued ? (
            <div className="space-y-3" data-testid="invite-issued">
              <div className="flex items-start gap-3">
                <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-orb-lime/15 text-orb-lime">
                  <Check className="size-4" />
                </span>
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-semibold text-orb-white">Invite link for {issued.invite.email}, shown once</p>
                  <p className="text-xs leading-relaxed text-orb-gray">
                    {issued.emailed
                      ? "It has also been emailed to them; copy it if you would rather send it yourself."
                      : "Nothing is emailed: copy the link and send it to them yourself."}{" "}
                    It works once, for that address only, until{" "}
                    {formatDate(issued.invite.expiresAt, { time: false })}. They join as {roleLabel(issued.invite.role)}.
                  </p>
                </div>
              </div>
              <div className="flex min-w-0 items-center gap-2 rounded-lg border border-orb-line bg-orb-space/70 p-1.5 pl-3">
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-orb-white" data-testid="invite-url">{issued.url}</code>
                <CopyButton text={issued.url} label="Copy link" size="sm" />
              </div>
              <Button type="button" size="sm" onClick={() => setIssued(null)}>Done</Button>
            </div>
          ) : (
            <>
              <PanelTitle>Invite someone</PanelTitle>
              <form onSubmit={invite} className="flex flex-wrap items-end gap-2" aria-label="Invite someone">
                <div className="min-w-56 flex-1 space-y-1.5">
                  <Label htmlFor="invite-email" className="text-xs text-orb-gray">Email</Label>
                  <Input
                    id="invite-email"
                    type="email"
                    autoComplete="off"
                    value={email}
                    placeholder="name@example.com"
                    onChange={(event) => { setEmail(event.target.value); setActionError(null); }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="invite-role" className="text-xs text-orb-gray">Role</Label>
                  <RoleSelect id="invite-role" value={inviteRole} onChange={setInviteRole} disabled={inviting} size="default" />
                </div>
                <Button type="submit" size="sm" className="h-9" disabled={inviting || !email.trim()}>
                  {inviting ? "Creating…" : "Create invite link"}
                </Button>
              </form>
              <p className="mt-2 text-xs text-orb-muted">You get a link to send them. It works once, for that address, for seven days.</p>
            </>
          )}
        </Panel>
      )}

      <RoleGuide />

      {confirmDialog}

      {role && role !== "owner" && (
        <Panel className="flex flex-wrap items-center justify-between gap-3 border-orb-coral/25">
          <div className="min-w-0">
            <p className="text-sm font-medium text-orb-white">Leave this workspace</p>
            <p className="text-xs text-orb-muted">You lose access at once; only an admin or the owner can invite you back.</p>
          </div>
          <Button type="button" variant="destructive" size="sm" onClick={leave} disabled={busy !== null}>
            <LogOut aria-hidden="true" />
            {busy === "leave" ? "Leaving…" : "Leave workspace"}
          </Button>
        </Panel>
      )}
    </div>
  );
}

/**
 * A role picker: the app's Select over the roles a member can hold. Named either by `label` or by
 * a `<Label htmlFor={id}>` beside it. Its value is always one of the roles, so it needs no
 * placeholder.
 */
function RoleSelect({ id, label, value, disabled, onChange, size = "sm" }) {
  return (
    <Select items={ROLE_ITEMS} value={value} disabled={disabled} onValueChange={(next) => { if (next) onChange(next); }}>
      <SelectTrigger id={id} aria-label={label} size={size} className="min-w-28">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {MEMBER_ROLES.map((role) => <SelectItem key={role} value={role}>{ROLE_LABELS[role]}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

/** How each role's pill is coloured: the owner in the accent, admins in the signal colour. */
const ROLE_TONES = Object.freeze({ owner: "lime", admin: "cyan", member: "neutral", "read-only": "muted" });

/**
 * What each role may do, as four short columns rather than a paragraph: each role adds to the one
 * before it, which a row of them shows at a glance.
 */
function RoleGuide() {
  const roles = [
    { role: "read-only", text: "Reads everything in the workspace." },
    { role: "member", text: "Also edits the Library, crawls, and sets agents to work." },
    { role: "admin", text: "Also invites people and changes their roles." },
    { role: "owner", text: "Pays for the workspace, including what members do. Cannot be changed or removed." },
  ];
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4" aria-label="What each role can do" role="list">
      {roles.map(({ role, text }) => (
        <div key={role} role="listitem" className="rounded-lg border border-orb-line/80 px-3 py-2.5">
          <Pill tone={ROLE_TONES[role]}>{ROLE_LABELS[role]}</Pill>
          <p className="mt-1.5 text-xs leading-relaxed text-orb-gray">{text}</p>
        </div>
      ))}
    </div>
  );
}
