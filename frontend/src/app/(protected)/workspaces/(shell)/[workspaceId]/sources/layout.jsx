import { Suspense } from "react";

import { AddSourceRoute } from "@/components/sources/AddSourceRoute";

/**
 * Every Sources page, with the Add a source dialog over it when the address asks for it
 * (`?add=1`, or `?add=<address>` from "Found on your website"), so any link can open it.
 */
export default function SourcesLayout({ children }) {
  return (
    <>
      {children}
      {/* Suspense because the dialog reads the address's query. */}
      <Suspense fallback={null}>
        <AddSourceRoute />
      </Suspense>
    </>
  );
}
