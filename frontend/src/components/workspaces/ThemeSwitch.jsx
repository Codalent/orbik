"use client";

import { Monitor, Moon, Sun } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTheme } from "@/lib/theme/ThemeProvider";
import { cn } from "@/lib/utils";

const THEMES = [
  { value: "dark", label: "Dark", icon: Moon },
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "Match system", icon: Monitor },
];

/**
 * The colour theme, as three buttons in the top bar beside the account: one click to change it,
 * from any page. It used to be inside the account menu, where people did not find it.
 *
 * Each button says whether it is the current choice with `aria-pressed`, and names itself to
 * anyone not looking at the icon; the tooltip names it for anyone who is.
 */
export function ThemeSwitch() {
  const { preference, setPreference } = useTheme();
  return (
    <div role="group" aria-label="Theme" className="flex h-8 items-center gap-0.5 rounded-[13px] border border-orb-line p-0.5">
      {THEMES.map(({ value, label, icon: Icon }) => {
        const current = preference === value;
        return (
          <Tooltip key={value}>
            <TooltipTrigger
              render={<button type="button" />}
              onClick={() => setPreference(value)}
              aria-pressed={current}
              aria-label={`${label} theme`}
              className={cn(
                "grid size-6 place-items-center rounded-[10px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/70",
                current ? "bg-orb-raised text-orb-white" : "text-orb-muted hover:text-orb-white",
              )}
            >
              <Icon aria-hidden="true" className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent side="bottom">{label} theme</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
