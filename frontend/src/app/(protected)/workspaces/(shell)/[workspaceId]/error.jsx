"use client";

import { useEffect } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * What a workspace page shows when rendering it throws.
 *
 * Sits inside the shell, so a fault in one page leaves the sidebar — and every other page — within
 * reach. Without it the error replaced the whole application with the framework's own screen, and
 * the only way back was the address bar.
 *
 * @param {object} props
 * @param {Error} props.error
 * @param {() => void} props.retry renders the page again
 */
export default function WorkspacePageError({ error, retry }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main aria-label="Page error" className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
      <Alert variant="destructive" role="alert" className="max-w-lg">
        <AlertDescription>This page could not be shown. Nothing was changed by the failure.</AlertDescription>
      </Alert>
      <Button type="button" variant="outline" onClick={() => retry()}>Try again</Button>
    </main>
  );
}
