import DesignSystemAgentView from "./view";

export const metadata = { title: "Design system agent" };

/**
 * The Design system agent: its setup, schedule and runs. The folder is named for the agent's slug
 * (`DESIGN_SYSTEM_AGENT_SLUG` in `src/lib/brand/brand.js`). What it derives is the Brand page, at
 * its own route.
 */
export default function DesignSystemAgentPage() {
  return <DesignSystemAgentView />;
}
