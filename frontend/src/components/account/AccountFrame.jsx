import Link from "next/link";
import { ArrowLeft } from "lucide-react";

/**
 * The frame of a page about the signed-in account or the install rather than one workspace — the
 * Admin page, and the pages a deployment's extension adds under /account — with a way back.
 */
export function AccountFrame({ children }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 px-4 py-5 sm:px-10 sm:pt-7 sm:pb-10">
      <Link href="/" className="-mb-2 inline-flex min-h-6 items-center gap-1.5 self-start text-xs text-orb-muted hover:text-orb-white">
        <ArrowLeft aria-hidden="true" className="size-3.5" />Back to Orbik
      </Link>
      {children}
    </main>
  );
}
