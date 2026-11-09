/**
 * Reads and writes the `agent_schedules` row behind an agent's on/off switch.
 *
 * One row per workspace and agent. The API writes the switch; the agents scheduler reads it and
 * moves `nextRunAt` as it starts runs.
 *
 * @param {object} collections agent collections from `@orbik/core`
 */
export function createAgentScheduleRepository(collections) {
  const { schedules } = collections;

  return {
    /** Whether the agent is switched on and when it runs next, or null when it never was. */
    find({ workspaceId, agentSlug }) {
      return schedules.findOne({ workspaceId, agentSlug }, { projection: { enabled: 1, nextRunAt: 1 } });
    },

    /** Switches the agent on or off, creating its row the first time. */
    save({ workspaceId, agentSlug, enabled, intervalHours, dueTimes, now }) {
      return schedules.updateOne(
        { workspaceId, agentSlug },
        {
          $set: {
            enabled,
            intervalHours,
            input: {},
            updatedAt: now,
            ...dueTimes,
          },
          $setOnInsert: { workspaceId, agentSlug, createdAt: now },
        },
        { upsert: true },
      );
    },
  };
}
