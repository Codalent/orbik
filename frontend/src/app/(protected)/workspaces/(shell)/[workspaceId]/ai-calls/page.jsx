import { redirect } from "next/navigation";

/**
 * Where the AI calls log used to be, when it was a button in the top bar. It is a section of
 * Settings now; an old link or bookmark lands there.
 */
export default async function AiCallsPage({ params }) {
  const { workspaceId } = await params;
  redirect(`/workspaces/${encodeURIComponent(workspaceId)}/settings/ai-calls`);
}
