"use client";

import { notFound, useParams } from "next/navigation";

import { AccountFrame } from "@/components/account/AccountFrame";
import { NeutralLoading } from "@/components/NeutralLoading";
import { ProtectedRoute } from "@/lib/auth/ProtectedRoute";
import { extensionApi, useExtensionSlots } from "@/lib/extensions/slots";

/**
 * The extension's account page at this path, for a signed-in person. A person who has no
 * workspace yet may open it too: it is about their account, not a workspace.
 */
export default function AccountPageView() {
  return (
    <ProtectedRoute allowOnboarding>
      <AccountPageContent />
    </ProtectedRoute>
  );
}

function AccountPageContent() {
  const { accountPage } = useParams();
  const path = Array.isArray(accountPage) ? accountPage : [accountPage].filter(Boolean);
  const { status, page } = useExtensionSlots().accountPage(path);

  if (status === "loading") return <NeutralLoading />;
  if (status === "missing") notFound();
  const { Component } = page;
  return (
    <AccountFrame>
      <Component path={path} api={extensionApi} />
    </AccountFrame>
  );
}
