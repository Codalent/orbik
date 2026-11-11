"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Check, FolderTree, Plus, RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { FIELD, LABEL } from "./LibraryCreateDialog";
import { LIBRARY_LIMITS, slugifySegment } from "@/lib/library/library";
import { cn } from "@/lib/utils";

/** How many top-level folders a structure may have. Mirrors `LIBRARY_LIMITS.groups` in `@orbik/library`. */
const MAX_GROUPS = 12;

/** The longest folder name a structure may use. Mirrors `LIBRARY_LIMITS.groupTitle`. */
const MAX_GROUP_TITLE = 40;

/** Top-level names Orbik keeps for folders it writes itself. Mirrors `structure.js`. */
const KEPT_NAMES = Object.freeze(new Set(["sources", "brand", "overview", "index"]));

/**
 * Choosing how the Library is organised, before the agent writes it.
 *
 * The top level of a Library is a few folders — `00 Start Here`, `01 Company`, `02 Offer` by
 * default — and they are the person's: the agent files into them and never adds, renames or
 * removes one. So before the first write run, and again when somebody asks for a rebuild, the
 * page asks. A model has read the site map and the core pages and proposed two or three
 * structures, each with a sentence on why it fits; the person picks one, and may rename, add,
 * remove or reorder folders before confirming. Until they do, the agent waits — which is said
 * here and in the agent's own line in the header, because a Library that never fills with no
 * reason given is the worst outcome of this step.
 *
 * When no proposal came back — no model on this deployment, or a failed call — the default
 * structure is offered to start from instead, so the choice never depends on the model.
 *
 * @param {object} props
 * @param {object} props.structure the `structure` block of GET /library
 * @param {boolean} props.working whether the agent is set to work
 * @param {boolean} props.busy
 * @param {(groups: Array<object>) => Promise<void>} props.onChoose saves the choice; throws a readable message
 * @param {() => Promise<void>} props.onSuggestAgain asks for new proposals
 */
export function LibraryStructureChoice({ structure, working, busy, onChoose, onSuggestAgain }) {
  const suggestion = structure.suggestion;
  const variants = suggestion?.status === "ready" ? suggestion.variants ?? [] : [];
  const options = [
    ...variants.map((variant, index) => ({ key: `variant-${index}`, name: variant.name, why: variant.why, groups: variant.groups })),
    {
      key: "default",
      name: "The default",
      why: "Orbik's standard structure. Folders with nothing on your site to put in them can be removed.",
      groups: structure.defaults ?? [],
    },
  ];
  const [picked, setPicked] = useState(null);
  const [draft, setDraft] = useState(null);
  const [failure, setFailure] = useState(null);
  const [pending, setPending] = useState(false);

  const current = picked ?? options[0]?.key ?? "default";
  const groups = draft ?? (options.find((option) => option.key === current)?.groups ?? []).map((group, index) => toDraft(group, `${current}-${index}`));
  const problems = groupProblems(groups);
  const rebuild = structure.reason === "rebuild";

  function pick(key) {
    setPicked(key);
    setDraft(null);
    setFailure(null);
  }

  function change(next) {
    setDraft(next);
    setFailure(null);
  }

  function update(index, values) {
    change(groups.map((group, at) => (at === index ? { ...group, ...values } : group)));
  }

  function move(index, by) {
    const next = [...groups];
    const [group] = next.splice(index, 1);
    next.splice(index + by, 0, group);
    change(next);
  }

  async function confirm() {
    if (problems.length || pending) return;
    setPending(true);
    setFailure(null);
    try {
      await onChoose(groups.map((group, index) => ({
        title: group.title.trim(),
        summary: group.summary.trim() || undefined,
        subjects: group.subjects,
        ...(index === 0 ? { start: true } : {}),
      })));
    } catch (error) {
      setFailure(error?.message ?? "That structure could not be saved.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="library-structure-title" className="min-h-0 flex-1 overflow-y-auto px-4 pb-10 pt-7 md:px-10">
      <div className="max-w-3xl">
        <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.12em] text-orb-lime">
          <FolderTree aria-hidden="true" className="size-3.5" /> {rebuild ? "Rebuild" : "Before the first write"}
        </p>
        <h2 id="library-structure-title" className="mt-2 font-display text-title font-bold leading-tight tracking-[-0.015em] text-orb-white">
          Choose how your Library is organised
        </h2>
        <p className="mt-1.5 text-[0.9375rem] leading-relaxed text-orb-gray">
          The agent writes into the top-level folders you choose here, and never adds, renames or removes one. Pick a
          structure, change it if you like, and confirm. The numbers are part of the names, so the folders read in order;
          you can rename any of them later, and every link follows.
          {working
            ? " The agent starts writing within a few minutes of confirming."
            : " The agent is paused: set it to work with the switch at the foot of the explorer, and it writes into these folders once you confirm."}
        </p>

        <SuggestionStatus suggestion={suggestion} working={working} busy={busy} onSuggestAgain={onSuggestAgain} />

        <div role="radiogroup" aria-label="Structures to choose from" className="mt-5 grid gap-2.5 md:grid-cols-2">
          {options.map((option) => {
            const selected = option.key === current;
            return (
              <label
                key={option.key}
                className={cn(
                  "flex cursor-pointer flex-col gap-2 rounded-3xl border px-4 py-3.5 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring/60",
                  selected ? "border-orb-lime/60 bg-orb-raised" : "border-orb-line hover:bg-orb-raised/60",
                )}
              >
                <input type="radio" name="library-structure" value={option.key} checked={selected} onChange={() => pick(option.key)} className="sr-only" />
                <span className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-orb-white">{option.name}</span>
                  {selected && <Check aria-hidden="true" className="size-4 shrink-0 text-orb-lime" />}
                </span>
                {option.why && <span className="text-compact leading-snug text-orb-gray">{option.why}</span>}
                <span className="flex flex-col gap-0.5 font-mono text-xs text-orb-muted">
                  {option.groups.map((group) => (
                    <span key={group.title} className="truncate">
                      <span className="text-orb-white">{group.title}</span>
                      {group.subjects?.length ? ` · ${group.subjects.join(", ")}` : ""}
                    </span>
                  ))}
                </span>
              </label>
            );
          })}
        </div>

        <div className="mt-7">
          <h3 className={LABEL}>Your folders</h3>
          <ol className="mt-2 flex flex-col gap-2">
            {groups.map((group, index) => (
              <li key={group.key} className="flex flex-col gap-1.5 rounded-2xl bg-orb-line/30 p-2.5">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    aria-label={`Name of folder ${index + 1}`}
                    value={group.title}
                    maxLength={MAX_GROUP_TITLE}
                    onChange={(event) => update(index, { title: event.target.value })}
                    className={cn(FIELD, "min-w-0 flex-1")}
                  />
                  <span className="hidden w-36 shrink-0 truncate font-mono text-xs text-orb-muted sm:block">
                    /{slugifySegment(group.title) || "…"}
                  </span>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="Move up" disabled={index === 0} onClick={() => move(index, -1)}>
                    <ArrowUp aria-hidden="true" className="size-3.5" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="Move down" disabled={index === groups.length - 1} onClick={() => move(index, 1)}>
                    <ArrowDown aria-hidden="true" className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${group.title || "this folder"}`}
                    disabled={groups.length === 1}
                    onClick={() => change(groups.filter((_group, at) => at !== index))}
                  >
                    <X aria-hidden="true" className="size-3.5" />
                  </Button>
                </div>
                <input
                  type="text"
                  aria-label={`What belongs in folder ${index + 1}`}
                  value={group.summary}
                  placeholder="What belongs here"
                  maxLength={LIBRARY_LIMITS.summary}
                  onChange={(event) => update(index, { summary: event.target.value })}
                  className={cn(FIELD, "h-8 text-compact")}
                />
                <p className="px-1 text-xs text-orb-muted">
                  {index === 0 ? "Holds the overview and the index. " : ""}
                  {group.subjects.length ? `The agent files ${group.subjects.join(", ")} here.` : "The agent files here whatever fits its description."}
                </p>
              </li>
            ))}
          </ol>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-2"
            disabled={groups.length >= MAX_GROUPS}
            onClick={() => change([...groups, toDraft({ title: nextTitle(groups), summary: "", subjects: [] }, `added-${Date.now()}`)])}
          >
            <Plus aria-hidden="true" className="size-3.5" /> Add a folder
          </Button>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button type="button" onClick={confirm} disabled={busy || pending || problems.length > 0}>
            {pending ? "Creating the folders…" : "Use this structure"}
          </Button>
          <span role={failure || problems.length ? "alert" : undefined} className={cn("text-xs", failure || problems.length ? "text-orb-coral" : "text-orb-muted")}>
            {failure ?? problems[0] ?? `${groups.length} ${groups.length === 1 ? "folder" : "folders"}, created as yours. Brand and Sources stay where they are.`}
          </span>
        </div>
      </div>
    </section>
  );
}

/**
 * Where the proposals stand: not asked for yet, being written, failed, or there.
 *
 * The scheduler asks a model for them only once the agent is set to work, so that a paused agent
 * spends nothing; until then there is nothing being proposed, and saying so is what keeps a person
 * from waiting on a spinner that never ends.
 */
function SuggestionStatus({ suggestion, working, busy, onSuggestAgain }) {
  if (!suggestion && !working) {
    return (
      <p role="status" className="mt-4 rounded-2xl bg-orb-raised px-3 py-2.5 text-compact text-orb-gray">
        Set the agent to work and it proposes two or three structures from your site within a few minutes. Or start from
        the default below now.
      </p>
    );
  }
  if (!suggestion || suggestion.status === "pending") {
    return (
      <p role="status" className="mt-4 flex items-center gap-2 rounded-2xl bg-orb-raised px-3 py-2.5 text-compact text-orb-gray">
        <RefreshCw aria-hidden="true" className="size-3.5 motion-safe:animate-spin" />
        Proposing structures from your site. They appear here in a minute or two; the default is below meanwhile.
      </p>
    );
  }
  if (suggestion.status === "ready") {
    return (
      <p className="mt-4 flex flex-wrap items-center gap-2 text-xs text-orb-muted">
        Proposed from your site’s pages.
        <Button type="button" variant="ghost" size="sm" onClick={onSuggestAgain} disabled={busy}>
          <RefreshCw aria-hidden="true" className="size-3.5" /> Propose again
        </Button>
      </p>
    );
  }
  return (
    <p role="alert" className="mt-4 flex flex-wrap items-center gap-2 rounded-2xl bg-orb-raised px-3 py-2.5 text-compact text-orb-gray">
      No structure could be proposed{suggestion.reason?.message ? `: ${suggestion.reason.message}` : "."} Start from the default below.
      <Button type="button" variant="ghost" size="sm" onClick={onSuggestAgain} disabled={busy}>
        <RefreshCw aria-hidden="true" className="size-3.5" /> Try again
      </Button>
    </p>
  );
}

/** A group as the editor holds it, with a key that survives reordering. */
function toDraft(group, key) {
  return { key, title: group.title ?? "", summary: group.summary ?? "", subjects: group.subjects ?? [] };
}

/** The next free number, by convention: `06 Partners` after `05 Content`. */
function nextTitle(groups) {
  const numbers = groups.map((group) => Number.parseInt(/^(\d{1,2})\s/.exec(group.title)?.[1] ?? "", 10)).filter(Number.isFinite);
  const next = numbers.length ? Math.max(...numbers) + 1 : groups.length;
  return `${String(next).padStart(2, "0")} New folder`;
}

/** What is wrong with the folders as they stand, said before the server has to. */
function groupProblems(groups) {
  const problems = [];
  const seen = new Set();
  if (!groups.length) problems.push("Keep at least one folder.");
  for (const group of groups) {
    const title = group.title.trim();
    const slug = slugifySegment(title);
    if (!title) problems.push("Every folder needs a name.");
    else if (!slug) problems.push(`“${title}” needs at least one letter or digit.`);
    else if (KEPT_NAMES.has(slug)) problems.push(`“${title}” is a name Orbik keeps for a folder it writes itself.`);
    else if (seen.has(slug)) problems.push(`Two folders would both be /${slug}.`);
    seen.add(slug);
  }
  return problems;
}
