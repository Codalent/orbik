"use client";

import Link from "next/link";
import { BookOpen, Code, KeyRound, LogOut, ShieldCheck } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useExtensionSlots } from "@/lib/extensions/slots";

/**
 * Where this install's source code is. Orbik is AGPL-licensed: someone who runs a changed copy for
 * other people offers them its source, and `NEXT_PUBLIC_ORBIK_SOURCE_URL` (fixed at build time) is
 * how they point this link at their own.
 */
const SOURCE_URL = process.env.NEXT_PUBLIC_ORBIK_SOURCE_URL || "https://github.com/Codalent/orbik";

/** Orbik's documentation, which the `docs/` folder of the source is published as. */
const DOCS_URL = "https://orbik.io/docs";

/**
 * The signed-in person, as their initial at the end of the top bar, opening what they can do
 * about the session: change their password (an account that has one), read the documentation,
 * see the source code, leave, and for the install's admins, the Admin page. A deployment's
 * `userMenuItems` come after Admin and Change password, before Documentation and Source code.
 * The colour theme is chosen beside it, with ThemeSwitch.
 *
 * @param {object} props
 * @param {string} [props.email] address of the signed-in person
 * @param {() => void} props.onSignOut ends the session
 * @param {boolean} [props.disabled] true while the shell is busy with something else
 * @param {boolean} [props.isAdmin] whether they administer the install, which adds the Admin page
 */
export function UserMenu({ email, onSignOut, disabled = false, isAdmin = false }) {
  const initial = email?.trim().charAt(0).toUpperCase() || "?";
  // What a deployment's extension adds: its account pages, a help link. Empty in this repository.
  const { userMenuItems } = useExtensionSlots();
  // An account made by signing in with Google has no password to change.
  const hasPassword = useAuth().user?.hasPassword !== false;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={email ? `Account: ${email}` : "Account"}
        className="grid size-7 shrink-0 place-items-center rounded-full bg-orb-raised text-xs font-semibold text-orb-gray outline-none transition-colors hover:text-orb-white focus-visible:ring-2 focus-visible:ring-ring/70 disabled:opacity-60 data-popup-open:text-orb-white"
      >
        <span aria-hidden="true">{initial}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {email && (
          <>
            <DropdownMenuGroup>
              <DropdownMenuLabel className="flex flex-col gap-0.5 pb-1.5">
                <span className="text-2xs font-medium uppercase tracking-[0.12em]">Signed in as</span>
                <span className="truncate text-compact text-orb-white">{email}</span>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        )}
        {isAdmin && (
          <DropdownMenuItem render={<Link href="/admin" />}>
            <ShieldCheck aria-hidden="true" />Admin
          </DropdownMenuItem>
        )}
        {hasPassword && (
          <DropdownMenuItem render={<Link href="/account/password" />}>
            <KeyRound aria-hidden="true" />Change password
          </DropdownMenuItem>
        )}
        {userMenuItems.map(({ id, label, icon: Icon, href }) => (
          <DropdownMenuItem key={id} render={isExternal(href) ? <a href={href} target="_blank" rel="noreferrer" /> : <Link href={href} />}>
            {Icon && <Icon aria-hidden="true" />}{label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem render={<a href={DOCS_URL} target="_blank" rel="noreferrer" />}>
          <BookOpen aria-hidden="true" />Documentation
        </DropdownMenuItem>
        <DropdownMenuItem render={<a href={SOURCE_URL} target="_blank" rel="noreferrer" />}>
          <Code aria-hidden="true" />Source code
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onSignOut}>
          <LogOut aria-hidden="true" />Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Whether a menu item leaves the app: an absolute http(s) address opens in a new tab. */
function isExternal(href) {
  return /^https?:\/\//i.test(href);
}
