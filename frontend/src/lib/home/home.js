import { personFromEmail } from "@/lib/format";

/**
 * The Home page's vocabulary: what each setup step is called, and how its states are worded.
 *
 * The states themselves are the API's (`GET /v1/workspaces/:id/home`), derived from what the
 * workspace records; nothing here decides whether a step is done, only how that is said.
 */

/** A step's state, as the API names it. */
export const STEP_STATE = Object.freeze({
  notStarted: "not_started",
  inProgress: "in_progress",
  done: "done",
  attention: "attention",
  notPermitted: "not_permitted",
  skipped: "skipped",
});

/** Each step's title, as the checklist lists it. */
export const STEP_TITLES = Object.freeze({
  website: "Connect your website",
  structure: "Choose how your Library is organised",
  library: "Library written",
  ai: "Connect Orbik MCP",
  brand: "Review your brand",
  team: "Invite your team",
});

/** How the step a person is waiting on is named in "Waits for …". */
export const WAITS_FOR = Object.freeze({
  website: "the first crawl",
  structure: "the Library's folders to be chosen",
});

/** Who can do a step a person's role cannot: "An admin can do this". */
export function whoCanDo(requires) {
  return requires === "admin" ? "An admin can do this" : requires === "owner" ? "The owner can do this" : "A member can do this";
}

/**
 * How long ago something happened, in words: "just now", "5 minutes ago", "2 days ago", and the
 * date after a month, when "34 days ago" is harder to read than the day itself.
 */
export function ago(iso, now = Date.now()) {
  if (!iso) return "";
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const words = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return words.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return words.format(-hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 31) return words.format(-days, "day");
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

/** When something is due, in words: "in 5 days", "tomorrow". */
export function fromNow(iso, now = Date.now()) {
  if (!iso) return "";
  const hours = Math.round((new Date(iso).getTime() - now) / 3_600_000);
  const words = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (hours < 1) return "within the hour";
  if (hours < 24) return words.format(hours, "hour");
  return words.format(Math.round(hours / 24), "day");
}

/**
 * A person the API names, as this page says them: "you" for the signed-in person, their name for
 * anybody else, and null when nobody is named.
 *
 * @param {{email?: string|null}|null|undefined} person
 * @param {string|null|undefined} myEmail the signed-in person's address
 */
export function personName(person, myEmail) {
  if (!person?.email) return null;
  if (myEmail && person.email.toLowerCase() === myEmail.toLowerCase()) return "you";
  return personFromEmail(person.email)?.name ?? person.email;
}

/** "Done 2 days ago by Priya", "Done just now". */
export function doneLine(step, myEmail) {
  const who = personName(step.doneBy, myEmail);
  return ["Done", step.doneAt ? ago(step.doneAt) : null, who ? `by ${who}` : null].filter(Boolean).join(" ");
}

/** A count and its noun: "1 file", "14 files". */
export function plural(count, one, many = `${one}s`) {
  return `${Number(count ?? 0).toLocaleString()} ${count === 1 ? one : many}`;
}
