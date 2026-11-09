"use client";

import { DevBarLoader } from "@/components/devbar/DevBarLoader";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiCacheProvider } from "@/lib/api/cache";
import { AuthProvider } from "@/lib/auth/AuthProvider";
import { ThemeProvider } from "@/lib/theme/ThemeProvider";

/** Client-only providers shared by all public and protected routes. */
export function AppProviders({ children }) {
  return <ThemeProvider><TooltipProvider><ApiCacheProvider><AuthProvider>{children}</AuthProvider><DevBarLoader /></ApiCacheProvider></TooltipProvider></ThemeProvider>;
}
