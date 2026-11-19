"use client";

import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";

import { useRevalidateWorkspace } from "@/lib/api/cache";
import { sourceHref } from "@/lib/sources/sources";
import { useSources } from "@/lib/sources/useSources";
import { AddSourceDialog } from "./AddSourceDialog";

/**
 * The Add a source dialog, open while the address carries `?add`: `1` for an empty one, or the
 * address to start from. Closing it takes the parameter off; adding goes to the new source.
 */
export function AddSourceRoute() {
  const { workspaceId } = useParams();
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const revalidate = useRevalidateWorkspace(workspaceId);
  const { data } = useSources(workspaceId);
  const add = params.get("add");
  if (add === null || !workspaceId) return null;
  return (
    <AddSourceDialog
      key={add}
      workspaceId={workspaceId}
      initialUrl={add === "1" ? "" : add}
      purposes={data?.purposes ?? []}
      onClose={() => router.replace(pathname)}
      onAdded={async (source) => {
        await revalidate();
        router.push(sourceHref(workspaceId, source));
      }}
    />
  );
}
