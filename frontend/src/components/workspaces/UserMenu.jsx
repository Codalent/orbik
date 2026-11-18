"use client";

import Link from "next/link";
import { BookOpen, Code, LogOut, Star } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useExtensionSlots } from "@/lib/extensions/slots";

/** Orbik's own repository, where its source is and where it can be starred. */
const ORBIK_REPOSITORY = "https://github.com/Codalent/orbik";

/**
 * Where this install's source code is. Orbik is AGPL-licensed: someone who runs a changed copy for
 * other people offers them its source, and `NEXT_PUBLIC_ORBIK_SOURCE_URL` (fixed at build time) is
 * how they point this link at their own. Left unset, the link is Orbik's repository and asks for a
 * star there, which leads to the same source; set, it says Source code and leads to theirs.
 */
const SOURCE_URL = process.env.NEXT_PUBLIC_ORBIK_SOURCE_URL || ORBIK_REPOSITORY;
const SOURCE_LINK = SOURCE_URL === ORBIK_REPOSITORY
  ? { label: "Star us on GitHub", icon: Star }
  : { label: "Source code", icon: Code };

/** Orbik's documentation, which the `docs/` folder of the source is published as. */
const DOCS_URL = "https://orbik.io/docs";

/**
 * The signed-in person, as their initial at the end of the top bar, opening what they can do
 * about the session: read the documentation, star Orbik on GitHub (or, on an install that names
 * its own source, see it), and leave. A deployment's `userMenuItems` come first, before
 * Documentation. Changing the password and the install's Admin page are sections of Settings
 * (SettingsFrame), not items here. The colour theme is chosen beside it, with ThemeSwitch.
 *
 * @param {object} props
 * @param {string} [props.email] address of the signed-in person
 * @param {() => void} props.onSignOut ends the session
 * @param {boolean} [props.disabled] true while the shell is busy with something else
 */
export function UserMenu({ email, onSignOut, disabled = false }) {
  const initial = email?.trim().charAt(0).toUpperCase() || "?";
  // What a deployment's extension adds: its account pages, a help link. Empty in this repository.
  const { userMenuItems } = useExtensionSlots();
  const SourceIcon = SOURCE_LINK.icon;
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
        {userMenuItems.map(({ id, label, icon: Icon, href }) => (
          <DropdownMenuItem key={id} render={isExternal(href) ? <a href={href} target="_blank" rel="noreferrer" /> : <Link href={href} />}>
            {Icon && <Icon aria-hidden="true" />}{label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem render={<a href={DOCS_URL} target="_blank" rel="noreferrer" />}>
          <BookOpen aria-hidden="true" />Documentation
        </DropdownMenuItem>
        <DropdownMenuItem render={<a href={SOURCE_URL} target="_blank" rel="noreferrer" />}>
          <SourceIcon aria-hidden="true" />{SOURCE_LINK.label}
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
