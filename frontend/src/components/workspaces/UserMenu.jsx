"use client";

import Link from "next/link";
import { Code, LogOut, ShieldCheck } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Where this install's source code is. Orbik is AGPL-licensed: someone who runs a changed copy for
 * other people offers them its source, and `NEXT_PUBLIC_ORBIK_SOURCE_URL` (fixed at build time) is
 * how they point this link at their own.
 */
const SOURCE_URL = process.env.NEXT_PUBLIC_ORBIK_SOURCE_URL || "https://github.com/Codalent/orbik";

/**
 * The signed-in person, as their initial at the end of the top bar, opening what they can do
 * about the session: leave, see the source code, and for the install's admins, the Admin page. The colour theme is chosen beside it, with ThemeSwitch.
 *
 * @param {object} props
 * @param {string} [props.email] address of the signed-in person
 * @param {() => void} props.onSignOut ends the session
 * @param {boolean} [props.disabled] true while the shell is busy with something else
 * @param {boolean} [props.isAdmin] whether they administer the install, which adds the Admin page
 */
export function UserMenu({ email, onSignOut, disabled = false, isAdmin = false }) {
  const initial = email?.trim().charAt(0).toUpperCase() || "?";
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
