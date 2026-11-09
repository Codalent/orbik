import { LlmCallLog } from "@/components/ai-calls/LlmCallLog";

export const metadata = { title: "AI calls · Settings" };

/**
 * The AI calls section of Settings, at `/settings/ai-calls`: every model call made on this
 * account's behalf.
 *
 * It sits under a workspace's Settings because that is where the shell is, but the log belongs to
 * the account: a call is made for a workspace, and a person wants to see all of theirs in one
 * place. So it is the LLM calls developer page's log, filters and totals included, and its
 * workspace filter starts at every workspace rather than this one.
 */
export default function AiCallsSettingsPage() {
  return <LlmCallLog embedded />;
}
