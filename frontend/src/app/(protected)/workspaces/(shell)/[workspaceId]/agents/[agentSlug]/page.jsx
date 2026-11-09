import AgentView from "./view";

export const metadata = { title: "Agent" };

/**
 * Any agent without a page of its own.
 *
 * The agents whose output is a document or a grid each have a folder beside this one, named by
 * slug. A static segment wins over this dynamic one, so those routes load only their own page
 * rather than every agent's.
 */
export default function AgentPage() {
  return <AgentView />;
}
