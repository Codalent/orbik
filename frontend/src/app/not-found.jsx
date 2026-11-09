import Link from "next/link";

import { OrbikLogo } from "@/components/OrbikLogo";

export const metadata = { title: "Page not found" };

/** What an address that matches no route shows, in the app's own frame rather than the framework's. */
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-5 p-6 text-center">
      <p className="flex items-center gap-2">
        <OrbikLogo className="h-[18px] w-auto shrink-0 text-orb-lime" />
      </p>
      <h1 className="font-display text-2xl font-bold tracking-[-0.02em] text-orb-white">Page not found</h1>
      <p className="max-w-sm text-sm text-orb-gray">There is nothing at this address. It may have been moved, or the link may be wrong.</p>
      <Link href="/" className="text-sm text-orb-white underline underline-offset-4">Go to Orbik</Link>
    </main>
  );
}
