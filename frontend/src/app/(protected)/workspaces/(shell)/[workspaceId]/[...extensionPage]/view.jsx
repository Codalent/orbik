"use client";

import { notFound, useParams } from "next/navigation";

import { NeutralLoading } from "@/components/NeutralLoading";
import { extensionApi, useExtensionSlots } from "@/lib/extensions/slots";

/** Renders the extension page at this address, or the not-found page when there is none. */
export default function ExtensionPageView() {
  const { workspaceId, extensionPage } = useParams();
  const path = Array.isArray(extensionPage) ? extensionPage : [extensionPage].filter(Boolean);
  const { status, page } = useExtensionSlots().page(path);
  if (status === "loading") return <NeutralLoading />;
  if (status === "missing") notFound();
  const { Component } = page;
  return <Component workspaceId={workspaceId} path={path} api={extensionApi} />;
}
