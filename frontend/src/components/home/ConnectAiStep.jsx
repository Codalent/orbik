"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConnectInstructions, defaultEndpointUrl } from "@/components/settings/ConnectYourAi";
import { createMcpToken } from "@/lib/api/mcp";
import { cn } from "@/lib/utils";

/** The two ways a person's AI connects, as the step's tabs name them. */
const TABS = Object.freeze([
  { id: "connector", label: "Claude.ai / ChatGPT" },
  { id: "token", label: "Claude Code / Cursor" },
]);

/**
 * The body of "Connect Orbik MCP" on Home: the two ways in, side by side.
 *
 * **Claude.ai / ChatGPT** take the endpoint as a custom connector and send the person back to
 * Orbik to sign in and approve — nothing to mint here. **Claude Code / Cursor** take a token, which
 * is minted inline and shown once with the same instructions the Settings card shows
 * (`ConnectInstructions`), so the two places never disagree about what to paste. A token minted
 * here reads this workspace and only reads; reaching more workspaces, or writing, is chosen on
 * Settings, where the whole card is.
 *
 * The step is done once the AI has called, not when a token exists, so after minting the step says
 * it is waiting for the first call — `onChanged` re-reads Home to show that.
 *
 * @param {object} props
 * @param {string} props.workspaceId
 * @param {string} props.settingsHref where the full card is
 * @param {() => void} props.onChanged re-reads Home after a token is minted
 */
export function ConnectAiStep({ workspaceId, settingsHref, onChanged }) {
  const endpointUrl = defaultEndpointUrl();
  const [tab, setTab] = useState("connector");
  const [name, setName] = useState("Claude Code");
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

  return (
    <div className="min-w-0 space-y-3">
      {/* A tab list rather than two buttons, so a screen reader says which way in is showing. */}
      <div role="tablist" aria-label="How your AI connects" className="flex flex-wrap gap-1 rounded-[13px] border border-orb-line p-1">
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
              "min-w-0 flex-1 rounded-[9px] px-3 py-1.5 text-compact font-medium transition-colors",
              tab === item.id ? "bg-orb-raised text-orb-white" : "text-orb-muted hover:text-orb-white",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "connector" ? (
        <div role="tabpanel" id="home-ai-panel-connector" aria-labelledby="home-ai-tab-connector" className="space-y-3">
          <CopyField label="Connector URL" value={endpointUrl} />
          <ol className="list-decimal space-y-1 pl-5 text-sm leading-relaxed text-orb-gray">
            <li>In Claude.ai or Claude Desktop, open <span className="text-orb-white">Settings → Connectors → Add custom connector</span>. In ChatGPT, add it as a connector in the same way.</li>
            <li>Paste the URL above and save.</li>
            <li>You are sent back to Orbik to sign in, choose which workspaces it may read, and approve.</li>
          </ol>
        </div>
      ) : (
        <div role="tabpanel" id="home-ai-panel-token" aria-labelledby="home-ai-tab-token" className="space-y-3">
          {issued ? (
            <ConnectInstructions issued={issued} endpointUrl={endpointUrl} onDone={() => setIssued(null)} />
          ) : (
            <form onSubmit={mint} className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1 basis-48 space-y-1.5">
                <Label htmlFor="home-ai-token-name">Name this connection</Label>
                <Input id="home-ai-token-name" value={name} maxLength={60} onChange={(event) => { setName(event.target.value); setFailure(null); }} />
              </div>
              <Button type="submit" disabled={creating || !name.trim()}>
                {creating ? "Creating…" : "Create token"}
              </Button>
            </form>
          )}
          {failure && <p role="alert" className="text-sm text-orb-coral">{failure}</p>}
          <p className="text-xs leading-relaxed text-orb-muted">
            A token made here reads this workspace and nothing else. To let it read every workspace or write
            to the Library, create it on <a href={settingsHref} className="underline underline-offset-4 hover:text-orb-white">Settings</a> instead.
          </p>
        </div>
      )}
    </div>
  );
}

/** A value to copy, with the button that copies it. */
function CopyField({ label, value }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // A browser that refuses the clipboard still shows the value, which can be selected by hand.
    }
  }

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-orb-muted">{label}</p>
      <div className="flex min-w-0 items-center gap-2 rounded-[13px] border border-orb-line bg-orb-space py-1 pl-3 pr-1">
        <code className="min-w-0 flex-1 truncate font-mono text-compact text-orb-white">{value}</code>
        <Button type="button" variant="ghost" size="sm" onClick={copy} aria-label={copied ? "Copied" : `Copy ${label}`}>
          {copied ? <Check aria-hidden="true" className="text-orb-lime" /> : <Copy aria-hidden="true" />}
          <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
        </Button>
      </div>
    </div>
  );
}
