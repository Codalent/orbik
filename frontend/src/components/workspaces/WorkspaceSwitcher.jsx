"use client";

import Link from "next/link";
import { ChevronsUpDown, House, Plus } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toDomain } from "@/lib/workspaces/domain";
import { roleLabel } from "@/lib/workspaces/roles";

/**
 * Collapsed workspace identity that opens the person's full workspace list on demand.
 *
 * A workspace somebody else owns says the person's role in it beside its domain; one they own says
 * nothing, which is what it always looked like.
 */
export function WorkspaceSwitcher({ workspaces, selectedWorkspaceId, onSelect, disabled = false }) {
  const selected = workspaces.find((workspace) => workspace.id === selectedWorkspaceId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={selected ? `Workspace: ${selected.name}` : "Select workspace"}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-medium text-orb-white outline-none transition-colors hover:bg-orb-raised focus-visible:ring-2 focus-visible:ring-ring/70 disabled:opacity-60 data-popup-open:bg-orb-raised"
      >
        <House aria-hidden="true" className="size-4 shrink-0 text-orb-gray" />
        <span className="truncate">{selected?.name ?? "Select workspace"}</span>
        {selected?.role && selected.role !== "owner" && (
          <span className="shrink-0 text-xs font-normal text-orb-muted" data-testid="selected-workspace-role">{roleLabel(selected.role)}</span>
        )}
        <ChevronsUpDown aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-orb-muted" />
      </DropdownMenuTrigger>
      {/* A width of its own: the trigger in the top bar is only as wide as the workspace's name,
          which is narrower than a name with its domain under it. */}
      <DropdownMenuContent className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-2xs font-medium uppercase tracking-[0.12em]">Workspaces</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={selectedWorkspaceId ?? ""} onValueChange={(value) => onSelect(value)}>
            {workspaces.map((workspace) => {
              const domain = toDomain(workspace.websiteUrl);
              const role = workspace.role && workspace.role !== "owner" ? roleLabel(workspace.role) : null;
              return (
                <DropdownMenuRadioItem key={workspace.id} value={workspace.id} className="gap-2.5 data-checked:text-orb-white">
                  <span
                    aria-hidden="true"
                    className="grid size-6 shrink-0 place-items-center rounded-md border border-orb-line bg-orb-space/60 text-2xs font-semibold text-orb-gray"
                  >
                    {workspace.name?.trim().charAt(0).toUpperCase() || "?"}
                  </span>
                  <span className="flex min-w-0 flex-col leading-tight">
                    <span className="truncate">{workspace.name}</span>
                    {(domain || role) && (
                      <span className="truncate text-2xs font-normal text-orb-muted" data-testid="workspace-role">
                        {[domain, role].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href="/workspaces/new" />}>
          <Plus aria-hidden="true" />Create workspace
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
