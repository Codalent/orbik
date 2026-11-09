"use client";

import { notFound, useParams } from "next/navigation";
import { Puzzle } from "lucide-react";

import { NeutralLoading } from "@/components/NeutralLoading";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { extensionApi, useExtensionSlots } from "@/lib/extensions/slots";

/** Renders the extension's settings section with this id, or the not-found page when there is none. */
export default function ExtensionSettingsView() {
  const { workspaceId, sectionId } = useParams();
  const { status, section } = useExtensionSlots().settingsSection(decodeURIComponent(sectionId));
  if (status === "loading") return <NeutralLoading />;
  if (status === "missing") notFound();
  const { id, title, description, Component } = section;
  return (
    <SettingsSection id={`extension-${id}`} icon={Puzzle} title={title} description={description}>
      <Component workspaceId={workspaceId} api={extensionApi} />
    </SettingsSection>
  );
}
