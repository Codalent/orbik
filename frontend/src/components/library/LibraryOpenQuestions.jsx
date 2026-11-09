"use client";

import { useMemo, useState } from "react";
import { Check, MessageSquareText } from "lucide-react";
import { useSWRConfig } from "swr";

import { LibraryMarkdown } from "./LibraryMarkdown";
import { useLibrary } from "./libraryContext";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { getLibraryNode, libraryNodePath, saveLibraryNode } from "@/lib/api/library";
import { isSourcePath } from "@/lib/library/library";
import { cn } from "@/lib/utils";

/** The heading a person's answers are kept under, at the foot of the open-questions file. */
export const ANSWERED_HEADING = "Answered by the team";

/**
 * Whether a node is the Library's open-questions file: the agent's list of what a reader would
 * want to know that the site never says. Found by its name, which the vocabulary fixes, wherever
 * the person's structure keeps it.
 */
export function isOpenQuestionsFile(node) {
  return node?.kind === "file" && !isSourcePath(node.path) && node.path.split("/").pop() === "open-questions";
}

/**
 * The open-questions file as questions a person can answer.
 *
 * The agent writes the file as sections of bullet points, each naming the file it concerns with a
 * `[[link]]`. Each bullet becomes a card: answering it writes the answer, as the person's own
 * paragraph, into the file the question names — where the agent keeps it as ground truth on every
 * later run and the person's AI reads it — and records it here under "Answered by the team", one
 * paragraph per answer so each keeps who wrote it. A question whose label is already recorded
 * there shows as answered. Nothing here changes what the agent wrote: both writes only add a
 * paragraph, which is the one change that leaves every agent passage exactly as it was.
 *
 * @param {object} props
 * @param {object} props.node the open-questions file, as read
 */
export function OpenQuestionsPanel({ node }) {
  const library = useLibrary();
  const { questions, answered } = useMemo(() => parseOpenQuestions(node.markdown ?? "", node.path), [node.markdown, node.path]);
  const files = useMemo(() => answerTargets(library.index, node.path), [library.index, node.path]);
  if (!questions.length) return null;

  const open = questions.filter((question) => !answered.has(keyOf(question.label)));
  const groups = groupBy(questions, (question) => question.group);

  return (
    <section aria-labelledby={`${node.path}-answer-title`} className="mb-7 rounded-xl border border-orb-line bg-orb-raised/40 p-4 sm:p-5" data-testid="open-questions-panel">
      <div className="flex flex-wrap items-start gap-3">
        <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-orb-line bg-orb-space/70 text-orb-lime">
          <MessageSquareText className="size-4" />
        </span>
        <div className="min-w-[12rem] flex-1">
          <h3 id={`${node.path}-answer-title`} className="text-sm font-semibold text-orb-white">Answer what the site leaves open</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-orb-gray">
            {library.canEdit
              ? "Your answer is saved as your own writing in the file the question is about, so the agent keeps it on every run and your AI reads it."
              : "Somebody with member access can answer these; each answer is kept in the file the question is about."}
          </p>
        </div>
        <span className="flex items-center gap-1.5">
          <Pill tone={open.length ? "orange" : "lime"} dot>{open.length ? `${open.length} open` : "All answered"}</Pill>
          {answered.size > 0 && <Pill tone="lime">{answered.size} answered</Pill>}
        </span>
      </div>

      <div className="mt-4 space-y-4">
        {groups.map(([group, items]) => (
          <div key={group || "questions"}>
            {group && <p className="mb-1.5 text-2xs font-medium uppercase tracking-[0.12em] text-orb-muted">{group}</p>}
            <ul className="divide-y divide-orb-line/70 overflow-hidden rounded-lg border border-orb-line bg-orb-space/50">
              {items.map((question) => (
                <QuestionRow
                  key={question.id}
                  node={node}
                  question={question}
                  answer={answered.get(keyOf(question.label)) ?? null}
                  files={files}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

/** One question: its label and text, and — for somebody who may write — the form that answers it. */
function QuestionRow({ node, question, answer, files }) {
  const library = useLibrary();
  const { mutate } = useSWRConfig();
  const [opened, setOpened] = useState(false);
  const [text, setText] = useState("");
  const [target, setTarget] = useState(question.targets.find((path) => files.some((file) => file.path === path)) ?? files[0]?.path ?? null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState(null);
  const formId = `${question.id}-answer`;

  async function save(event) {
    event.preventDefault();
    const words = text.trim();
    if (!words || !target) return;
    setSaving(true);
    setFailure(null);
    try {
      await appendParagraph(library.workspaceId, target, `**${question.label}:** ${words}`);
      await appendAnswered(library.workspaceId, node.path, `**${question.label}** — ${oneLine(words)} · saved to [[${target}]]`);
      await Promise.all([
        mutate(libraryNodePath(library.workspaceId, target)),
        mutate(libraryNodePath(library.workspaceId, node.path)),
        library.refresh(),
      ]);
      setOpened(false);
      setText("");
    } catch (error) {
      setFailure(error?.message ?? "The answer could not be saved. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className={cn("px-3 py-3 sm:px-4", answer && "bg-orb-lime/[0.03]")}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-[12rem] flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-orb-white">
            {question.label}
            {answer && <Pill tone="lime" dot>Answered</Pill>}
          </p>
          {!opened && !answer && <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-orb-gray">{plainText(question.body)}</p>}
        </div>
        {library.canEdit && !answer && !opened && (
          <Button type="button" variant="outline" size="sm" onClick={() => setOpened(true)} aria-label={`Answer: ${question.label}`}>
            Answer
          </Button>
        )}
      </div>

      {answer && (
        <div className="mt-1.5 text-xs leading-relaxed text-orb-gray">
          <LibraryMarkdown markdown={answer} onOpen={library.open} titleOf={library.titleOf} idPrefix={`${question.id}-a-`} />
        </div>
      )}

      {opened && (
        <form id={formId} onSubmit={save} className="mt-2 space-y-3">
          <div className="rounded-md border border-orb-line/70 bg-orb-raised/40 px-3 py-2 text-xs leading-relaxed text-orb-gray">
            <LibraryMarkdown markdown={question.body} onOpen={library.open} titleOf={library.titleOf} idPrefix={`${question.id}-q-`} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${formId}-text`} className="text-xs text-orb-gray">Your answer</label>
            <Textarea
              id={`${formId}-text`}
              value={text}
              rows={3}
              maxLength={4000}
              autoFocus
              onChange={(event) => { setText(event.target.value); setFailure(null); }}
              placeholder="What is true, in your own words. The agent treats it as ground truth."
            />
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[12rem] flex-1 space-y-1.5">
              <label htmlFor={`${formId}-target`} className="text-xs text-orb-gray">Save to</label>
              <Select
                items={Object.fromEntries(files.map((file) => [file.path, file.label]))}
                value={target}
                onValueChange={(next) => { if (next) setTarget(next); }}
              >
                <SelectTrigger id={`${formId}-target`} aria-label="Save the answer to" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {files.map((file) => <SelectItem key={file.path} value={file.path}>{file.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Button type="button" variant="ghost" size="sm" className="h-9" onClick={() => { setOpened(false); setFailure(null); }} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" size="sm" className="h-9" disabled={saving || !text.trim() || !target}>
              <Check aria-hidden="true" />
              {saving ? "Saving…" : "Save answer"}
            </Button>
          </div>
          {failure && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{failure}</AlertDescription>
            </Alert>
          )}
        </form>
      )}
    </li>
  );
}

/**
 * Reads the open-questions file: every top-level bullet outside "Answered by the team" as a
 * question, under the heading it sits beneath, and every answer recorded under that heading by the
 * label it starts with.
 *
 * A question's label is its bold lead-in ("**Buying criteria:** …"), as the agent writes them;
 * a bullet without one is labelled by its opening words.
 *
 * @param {string} markdown
 * @param {string} selfPath the file's own path, never offered as where an answer goes
 * @returns {{questions: Array<{id: string, group: string, label: string, body: string, targets: string[]}>, answered: Map<string, string>}}
 */
export function parseOpenQuestions(markdown, selfPath) {
  const questions = [];
  const answered = new Map();
  let group = "";
  let inAnswered = false;
  let current = null;
  const finish = () => {
    if (current) questions.push(current);
    current = null;
  };

  for (const line of String(markdown).split("\n")) {
    const heading = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (heading) {
      finish();
      group = heading[1].trim();
      inAnswered = group.toLowerCase() === ANSWERED_HEADING.toLowerCase();
      continue;
    }
    if (inAnswered) {
      const recorded = line.match(/^\*\*(.+?)\*\*/);
      if (recorded) answered.set(keyOf(recorded[1]), line.trim());
      continue;
    }
    const bullet = line.match(/^[-*+]\s+(.*)$/);
    if (bullet) {
      finish();
      current = { group, body: bullet[1].trim() };
      continue;
    }
    if (current && /^\s+\S/.test(line)) {
      current.body += ` ${line.trim()}`;
      continue;
    }
    if (current && !line.trim()) finish();
  }
  finish();

  return {
    questions: questions.map((question, index) => {
      const lead = question.body.match(/^\*\*(.+?)\*\*:?\s*/);
      const label = lead ? lead[1].replace(/:$/, "").trim() : openingWords(question.body);
      const targets = [...question.body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)]
        .map((match) => match[1].trim())
        .filter((path) => path !== selfPath && !isSourcePath(path));
      return { id: `oq-${index}`, group: question.group, label, body: question.body, targets };
    }),
    answered,
  };
}

/** A label as a key: case and spacing do not make two questions different. */
function keyOf(label) {
  return String(label ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** A bullet's first words, for one with no bold lead-in. */
function openingWords(text) {
  const plain = plainText(text);
  const cut = plain.split(/[.:;?!]/)[0];
  return cut.length > 70 ? `${cut.slice(0, 67).trimEnd()}…` : cut;
}

/** Markdown as the words a reader sees: links as their labels, no emphasis marks. */
function plainText(markdown) {
  return String(markdown ?? "")
    .replace(/\[\[([^\]|]+)\|([^\]]*)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, (_match, path) => path.split("/").pop().replace(/-/g, " "))
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .trim();
}

/** An answer on one line, for the record under "Answered by the team". */
function oneLine(text) {
  return text.replace(/\s*\n+\s*/g, " ").trim();
}

/** The files an answer can be saved to: every file of the knowledge base, titled and sorted. */
function answerTargets(index, selfPath) {
  const files = [];
  for (const [path, entry] of index ?? []) {
    if (entry?.kind !== "file" || path === selfPath || isSourcePath(path)) continue;
    files.push({ path, label: `${entry.title || path.split("/").pop()} — ${path}` });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/** Items grouped by a key, keeping the order each group first appears in. */
function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()];
}

/**
 * Adds a paragraph to the end of a file as this person, keeping everything else exactly as it is:
 * the Markdown, the title, the summary, the tags and the agent's record of its sources — which the
 * store keeps as recorded on a person's save, so answering does not hide that a file is behind.
 */
async function appendParagraph(workspaceId, path, paragraph) {
  const { node } = await getLibraryNode(workspaceId, path);
  const markdown = String(node.markdown ?? "").trimEnd();
  // Already there — a save that reached this file and failed on the next — is not added twice.
  if (markdown.split(/\n{2,}/).some((block) => block.trim() === paragraph.trim())) return;
  await saveFile(workspaceId, node, `${markdown}\n\n${paragraph}\n`);
}

/** Records an answer under "Answered by the team", adding the heading the first time. */
async function appendAnswered(workspaceId, path, record) {
  const { node } = await getLibraryNode(workspaceId, path);
  const markdown = String(node.markdown ?? "").trimEnd();
  const heading = new RegExp(`^#{2,6}\\s+${ANSWERED_HEADING}\\s*$`, "mi");
  const next = heading.test(markdown) ? insertAfterSection(markdown, heading, record) : `${markdown}\n\n## ${ANSWERED_HEADING}\n\n${record}`;
  await saveFile(workspaceId, node, `${next}\n`);
}

/** Puts a paragraph at the end of the section a heading starts, before the next heading. */
function insertAfterSection(markdown, heading, paragraph) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => heading.test(line));
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{1,6}\s/.test(lines[index])) { end = index; break; }
  }
  const before = lines.slice(0, end).join("\n").trimEnd();
  const after = lines.slice(end).join("\n").trim();
  return after ? `${before}\n\n${paragraph}\n\n${after}` : `${before}\n\n${paragraph}`;
}

/** Saves a file's new Markdown through the same whole-file save the editor uses. */
function saveFile(workspaceId, node, markdown) {
  return saveLibraryNode(workspaceId, node.path, {
    kind: "file",
    title: node.title ?? node.name,
    summary: node.summary ?? "",
    markdown,
    tags: node.tags ?? [],
    sources: (node.sources ?? []).map((source) => ({ kind: source.kind, ref: source.url ?? source.key })),
  });
}
