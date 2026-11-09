import { LlmCallLog } from "@/components/ai-calls/LlmCallLog";
import { ProtectedRoute } from "@/lib/auth/ProtectedRoute";

export const metadata = { title: "LLM calls" };

/**
 * Every model call Orbik makes, for developers: what was sent, to which model, what came back,
 * and what it cost.
 *
 * Standalone, outside the workspace shell, because it spans workspaces. It reads the signed-in
 * account's calls, so it is behind the same sign-in as the app.
 * The AI calls section of a workspace's Settings shows the same log, embedded in the shell.
 */
export default function LlmCallsPage() {
  return (
    <ProtectedRoute>
      <LlmCallLog />
    </ProtectedRoute>
  );
}
