/**
 * Where live activity is read from — everything running on the account's behalf right now:
 * crawls, agent runs, model calls — and also its cache key.
 *
 * One request across every workspace, because the activity monitor that shows it sits in the
 * sidebar and is visible from every workspace.
 */
export const LIVE_ACTIVITY_PATH = "/v1/activity";
