"use client";

import { useEffect, useState } from "react";
import { Check, Copy, MessagesSquare, Terminal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChatAppLinks } from "@/components/settings/ChatApps";
import { ConnectInstructions, defaultEndpointUrl } from "@/components/settings/ConnectYourAi";
import { createMcpToken } from "@/lib/api/mcp";
import { STEP_STATE } from "@/lib/home/home";
import { cn } from "@/lib/utils";

/** The two kinds of AI a person uses, as the step's tabs name them; the chat apps first, and shown. */
const TABS = Object.freeze([
  { id: "chat", label: "Claude.ai, ChatGPT, Gemini, Grok", Icon: MessagesSquare },
  { id: "agent", label: "Claude Code, Cursor, Codex", Icon: Terminal },
]);

/**
 * The body of "Connect Orbik MCP" on Home: connecting the person's own AI in as few moves as it
 * takes.
 *
 * **Claude.ai, ChatGPT, Gemini, Grok**, shown first, cannot add a server themselves: copy the
 * connector URL, open the app's connector settings (each under its own mark, `ChatAppLinks`), and
 * come back to Orbik to sign in and approve.
 *
 * **Claude Code, Cursor, Codex** — an agent that can change its own MCP configuration — get a
 * prompt to paste: the agent adds Orbik and sends the person to sign in, through Orbik's OAuth, so
 * nothing is minted here. "Set it up by hand instead" holds the Claude Code command, the URL for
 * any other client, and a token for where nobody can sign in, minted inline and shown with the same
 * instructions the Settings card shows (`ConnectInstructions`), so the two places never disagree.
 * A token minted here reads this workspace and only reads; more is chosen on Settings.
 *
 * The step is done once the AI has called, not when it is added, so under both it says it is
 * waiting for that first call. Home re-reads itself (every five seconds once a client is connected,
 * and when the tab is looked at again), which is what ticks the step off.
 *
 * @param {object} props
 * @param {string} props.workspaceId
 * @param {string|null} props.workspaceName named in the prompt, so the agent knows which workspace
 * @param {string} props.state the step's state, for the waiting line
 * @param {string} props.settingsHref where the full card is
 * @param {() => void} props.onChanged re-reads Home after a token is minted
 */
export function ConnectAiStep({ workspaceId, workspaceName, state, settingsHref, onChanged }) {
  const endpointUrl = defaultEndpointUrl();
  const [tab, setTab] = useState("chat");

  return (
    <div className="min-w-0 space-y-4">
      {/* A tab list rather than two buttons, so a screen reader says which way in is showing. */}
      <div
        role="tablist"
        aria-label="Where do you use AI?"
        className="flex w-full flex-wrap gap-0.5 rounded-[13px] border border-orb-line bg-orb-space/60 p-[3px] sm:inline-flex sm:w-auto sm:rounded-full"
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`home-ai-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`home-ai-panel-${item.id}`}
            onClick={() => setTab(item.id)}
            className={cn(
              "inline-flex min-h-9 min-w-0 flex-1 items-center justify-center gap-2 rounded-[10px] px-3 py-1.5 text-compact font-medium leading-tight transition-colors sm:flex-none sm:rounded-full sm:px-4",
              tab === item.id ? "bg-orb-raised text-orb-white" : "text-orb-muted hover:text-orb-white",
            )}
          >
            <item.Icon aria-hidden="true" className="hidden size-3.5 shrink-0 sm:block" />
            {item.label}
          </button>
        ))}
      </div>

      {tab === "chat" ? (
        <div role="tabpanel" id="home-ai-panel-chat" aria-labelledby="home-ai-tab-chat">
          <ChatPanel endpointUrl={endpointUrl} />
        </div>
      ) : (
        <div role="tabpanel" id="home-ai-panel-agent" aria-labelledby="home-ai-tab-agent" className="space-y-3">
          <AgentPanel workspaceId={workspaceId} workspaceName={workspaceName} endpointUrl={endpointUrl} settingsHref={settingsHref} onChanged={onChanged} />
        </div>
      )}

      {state !== STEP_STATE.done && (
        <p role="status" className="flex items-center gap-2.5 text-compact text-orb-gray">
          <span aria-hidden="true" className="size-2 shrink-0 animate-pulse rounded-full bg-orb-cyan ring-4 ring-orb-cyan/20 motion-reduce:animate-none" />
          {state === STEP_STATE.inProgress
            ? "Connected. Waiting for your AI's first call: ask it something about this workspace."
            : "Waiting for your AI's first call. This step ticks itself off when it connects."}
        </p>
      )}
    </div>
  );
}

/**
 * A coding agent: the prompt that has it connect Orbik itself, and the manual ways underneath.
 */
function AgentPanel({ workspaceId, workspaceName, endpointUrl, settingsHref, onChanged }) {
  const prompt = agentPrompt(endpointUrl, workspaceName);
  const command = `claude mcp add --transport http orbik ${endpointUrl}`;

  return (
    <>
      <p className="text-sm font-medium text-orb-white">Paste this into your agent</p>
      <div className="flex flex-wrap items-start gap-4 rounded-[13px] border border-orb-line bg-orb-space/60 p-4">
        <pre className="min-w-0 flex-[1_1_18rem] whitespace-pre-wrap break-words font-mono text-compact leading-relaxed text-orb-white">{prompt}</pre>
        <CopyAction text={prompt} label="Copy prompt" primary />
      </div>
      <p className="text-compact text-orb-gray">
        Your agent adds Orbik, then you sign in to Orbik in your browser and choose what it may read. No token needed.
      </p>
      <details className="text-orb-muted">
        <summary className="w-max cursor-pointer rounded-md text-compact font-medium hover:text-orb-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70">
          Set it up by hand instead
        </summary>
        <div className="mt-3 space-y-4">
          <CopyField label="Claude Code: run this, then type /mcp and sign in to orbik" value={command} />
          <CopyField label="Cursor, Codex and others: add an HTTP MCP server named orbik with this URL" value={endpointUrl} />
          <TokenForm workspaceId={workspaceId} endpointUrl={endpointUrl} settingsHref={settingsHref} onChanged={onChanged} />
        </div>
      </details>
    </>
  );
}

/** A chat app: copy the URL, add it in the app's connector settings, come back to sign in. */
function ChatPanel({ endpointUrl }) {
  return (
    <ol className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(15rem,1fr))]">
      <li className="flex min-w-0 flex-col gap-3 rounded-[13px] border border-orb-line p-4">
        <span className="text-xs font-medium tabular-nums text-orb-muted">1 · Copy the connector URL</span>
        <div className="flex min-w-0 items-center gap-2 rounded-[13px] border border-orb-line bg-orb-space/60 py-1 pl-3 pr-1">
          <code className="min-w-0 flex-1 truncate font-mono text-compact text-orb-white">{endpointUrl}</code>
          <CopyAction text={endpointUrl} label="Copy" primary ariaLabel="Copy the connector URL" />
        </div>
      </li>
      <li className="flex min-w-0 flex-col gap-3 rounded-[13px] border border-orb-line p-4">
        <span className="text-xs font-medium tabular-nums text-orb-muted">2 · Add it as a custom connector</span>
        <ChatAppLinks />
        <span className="text-xs leading-relaxed text-orb-gray">
          Each opens the app&apos;s connector settings. Name it Orbik and paste the URL. You come back to Orbik to sign in
          and choose what it may read.
        </span>
      </li>
    </ol>
  );
}

/**
 * A token, for where nobody can sign in: a server, CI, or a client without OAuth. Minted inline and
 * shown once with what to paste where.
 */
function TokenForm({ workspaceId, endpointUrl, settingsHref, onChanged }) {
  const [name, setName] = useState("");
  const [issued, setIssued] = useState(null);
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState(null);

  async function mint(event) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setFailure(null);
    try {
      setIssued(await createMcpToken(workspaceId, { name: trimmed }));
      onChanged?.();
    } catch (error) {
      setFailure(error?.message ?? "The token could not be created. Try again.");
    } finally {
      setCreating(false);
    }
  }

  if (issued) return <ConnectInstructions issued={issued} endpointUrl={endpointUrl} onDone={() => setIssued(null)} />;

  return (
    <div className="space-y-2">
      <p className="text-xs leading-relaxed text-orb-gray">
        Where nobody can sign in — a server, CI, or a client without OAuth — use a token. It reads this workspace and nothing
        else; to let it read every workspace or write to the Library, create it on{" "}
        <a href={settingsHref} className="text-orb-cyan underline underline-offset-4 hover:text-orb-white">Settings</a> instead.
      </p>
      <form onSubmit={mint} className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 basis-48 space-y-1.5">
          <Label htmlFor="home-ai-token-name" className="text-xs text-orb-gray">Name this connection</Label>
          <Input
            id="home-ai-token-name"
            value={name}
            maxLength={60}
            placeholder="CI on the build server"
            onChange={(event) => { setName(event.target.value); setFailure(null); }}
          />
        </div>
        <Button type="submit" variant="outline" disabled={creating || !name.trim()}>
          {creating ? "Creating…" : "Create token"}
        </Button>
      </form>
      {failure && <p role="alert" className="text-sm text-orb-coral">{failure}</p>}
    </div>
  );
}

/**
 * The prompt a coding agent is given: add the server under a fixed name, sign in rather than ask
 * for a key, and prove it works by listing the Library's folders — a read that needs nothing else
 * set up. Named by the workspace, because a sign-in may cover several and the agent would
 * otherwise have to ask which.
 */
function agentPrompt(endpointUrl, workspaceName) {
  const library = workspaceName ? `the ${workspaceName} Library` : "my workspace's Library";
  return [
    `Add the Orbik MCP server to your MCP configuration: name orbik, URL ${endpointUrl}, transport Streamable HTTP.`,
    `It signs in with OAuth, so no token or API key is needed. In Claude Code, run: claude mcp add --transport http orbik ${endpointUrl}`,
    `Then help me sign in, and list the top-level folders of ${library} to confirm it works.`,
  ].join("\n");
}

/** A button that copies `text`, and says "Copied" for two seconds. */
function CopyAction({ text, label, primary = false, ariaLabel }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // A browser that refuses the clipboard still shows the text, which can be selected by hand.
    }
  }

  return (
    <Button type="button" size="sm" variant={primary ? "default" : "outline"} onClick={copy} aria-label={copied ? "Copied" : ariaLabel} className="shrink-0">
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {copied ? "Copied" : label}
    </Button>
  );
}

/** A value to copy, under its label, with the button that copies it. */
function CopyField({ label, value }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-orb-gray">{label}</p>
      <div className="flex min-w-0 items-center gap-2 rounded-[13px] border border-orb-line bg-orb-space/60 py-1 pl-3 pr-1">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-compact text-orb-white">{value}</code>
        <CopyAction text={value} label="Copy" ariaLabel={`Copy ${value}`} />
      </div>
    </div>
  );
}
