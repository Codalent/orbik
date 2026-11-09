import LlmsTxtView from "./view";

export const metadata = { title: "llms.txt" };

/** The llms.txt agent. The folder is named for the agent's slug (`LLMS_TXT_AGENT_SLUG`). */
export default function LlmsTxtAgentPage() {
  return <LlmsTxtView />;
}
