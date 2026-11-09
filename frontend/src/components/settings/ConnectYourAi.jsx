"use client";

import { useCallback, useState } from "react";
import { AppWindow, Check, KeyRound, TerminalSquare } from "lucide-react";
import useSWR from "swr";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyButton } from "@/components/brand/CopyButton";
import { Panel, PanelTitle, RowList } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { ConnectYourAiSkeleton } from "./SettingsSkeletons";
import * as mcpApi from "@/lib/api/mcp";
import * as oauthApi from "@/lib/api/oauth";
import { getApiBaseUrl } from "@/lib/api/client";
import { WORKSPACES_PATH } from "@/lib/api/workspaces";
import { can, roleOf } from "@/lib/workspaces/roles";
import { cn } from "@/lib/utils";

/**
 * Connecting somebody's own AI — Claude, ChatGPT, Claude Code, Cursor, an agent they built — to this
 * workspace.
 *
 * The card leads with a prompt the person pastes into their own AI, which connects Orbik for them
 * where it can and walks them through it where it cannot. The manual way follows: one tab per kind
 * of AI, each a few numbered steps with what to paste shown in full beside its copy button, and a
 * first prompt to try once connected. Claude's
 * apps, ChatGPT and Claude Code sign in through Orbik's OAuth, so they need no token; the token form
 * is for everything else. What is already connected comes after.
 *
 * A token minted here reads this workspace, or — if the person says so — all of their workspaces,
 * including ones they create or join later. A set is safe for the same reason one workspace was: the
 * server never trusts the stored set on its own, but intersects it with what the person can read on
 * every request, and a client that names a workspace can only pick a member of that intersection.
 * A token that reads several shows its tools a `workspace` argument; one that reads this workspace
 * alone sees exactly what tokens always saw.
 *
 * The card lists every token and every approved app that can read this workspace, wherever it was
 * minted or approved, and says what each one reads and whether it may write. Revoking one here
 * stops it everywhere it reads.
 *
 * A token only reads unless the person ticks "May write to the Library" when minting it, off by
 * default. One that may write creates and updates Library files as the person — what it adds is
 * theirs, kept from Orbik's agents, and the file's history says "you, via" the token's name.
 *
 * The model doing the reading is the caller's own, and this is only the knowledge base it reads.
 *
 * @param {object} props
 * @param {string} props.workspaceId the workspace whose card this is
 */
export function ConnectYourAi({ workspaceId, endpointUrl = defaultEndpointUrl() }) {
  // Which AI the person said they use: the tab whose steps are showing.
  const [clientTab, setClientTab] = useState(CLIENTS[0].id);
  const [name, setName] = useState("");
  // What a token minted here reads: "this" workspace, or "all" of the person's.
  const [reach, setReach] = useState("this");
  // Whether a token minted here may also write to the Library. Off until the person ticks it.
  const [write, setWrite] = useState(false);
  const [issued, setIssued] = useState(null);
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState(null);

  // Two halves of one answer to "what can read this workspace". Both are re-read when the tab is
  // looked at again, which is when an app approved in another window — the consent screen opens
  // in one — shows up here without a reload.
  // Writing needs member or above on every workspace a token covers — the API refuses it otherwise —
  // so the box is offered only when that holds for the reach chosen: this workspace, or every
  // workspace in the person's list. The list is the shell's, from the same cache.
  const workspaceList = useSWR(WORKSPACES_PATH).data?.items ?? [];
  const writeBlocked = writeRefusal(workspaceList, workspaceId, reach);
  const mayAskToWrite = !writeBlocked;
  // A box that became blocked is cleared, so it does not come back ticked when the reach changes back.
  if (writeBlocked && write) setWrite(false);

  const tokensRead = useSWR(mcpApi.mcpTokensPath(workspaceId));
  const grantsRead = useSWR(oauthApi.mcpGrantsPath(workspaceId));
  const tokens = tokensRead.data?.items ?? [];
  const grants = grantsRead.data?.items ?? [];
  const readFailure = (!tokensRead.data && tokensRead.error) || (!grantsRead.data && grantsRead.error) || null;
  // Held back until both have answered or failed, so half of the answer is never shown first.
  const loading = !(tokensRead.data || tokensRead.error) || !(grantsRead.data || grantsRead.error);
  const error = actionError ?? readFailure?.message ?? null;

  const report = useCallback((failure) => {
    setActionError(failure?.message ?? "Something went wrong. Try again.");
  }, []);

  /**
   * Mints a token and shows it, once.
   *
   * Held in component state and never re-fetched, because the server keeps only an argon2id hash
   * and cannot show it again. The panel says so next to the token rather than letting somebody
   * navigate away and discover it tomorrow.
   */
  async function connect(event) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    setActionError(null);
    try {
      const response = await mcpApi.createMcpToken(workspaceId, {
        name: trimmed,
        workspaces: reach === "all" ? { mode: "all" } : undefined,
        write: write && mayAskToWrite,
      });
      setIssued(response);
      setName("");
      setReach("this");
      setWrite(false);
      await tokensRead.mutate();
    } catch (failure) {
      report(failure);
    } finally {
      setCreating(false);
    }
  }

  /**
   * Revokes one token — everywhere it reads, not only here — and re-reads the list.
   *
   * Re-read rather than edited here: revoking is the
   * server's decision, and a list edited optimistically would disagree with it the moment anything
   * else changed.
   */
  async function revoke(tokenId) {
    setActionError(null);
    try {
      await mcpApi.revokeMcpToken(workspaceId, tokenId);
      await tokensRead.mutate();
    } catch (failure) {
      report(failure);
    }
  }

  /** Disconnects one app a person approved, from every workspace it reads, killing its tokens in the same breath. */
  async function disconnect(grantId) {
    setActionError(null);
    try {
      await oauthApi.revokeMcpGrant(workspaceId, grantId);
      await grantsRead.mutate();
    } catch (failure) {
      report(failure);
    }
  }

  if (loading) return <ConnectYourAiSkeleton />;

  const activeCount = grants.filter((grant) => grant.status === "active").length + tokens.filter((token) => token.status === "active").length;
  const workspaceName = workspaceList.find((workspace) => workspace.id === workspaceId)?.name ?? null;

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Panel className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-orb-white">Connect Orbik MCP</h3>
          <p className="text-xs leading-relaxed text-orb-gray">
            Once connected, your AI answers from this workspace&apos;s Library, crawled pages and llms.txt.
          </p>
        </div>

        <div>
          <p className="text-sm text-orb-gray">
            <span className="font-medium text-orb-white">Quickest: paste this into the AI you use.</span> A coding agent such as
            Claude Code or Cursor adds Orbik itself; Claude.ai and ChatGPT tell you where to click.
          </p>
          <PasteBlock label="Prompt" text={connectPrompt(endpointUrl, workspaceName)} />
        </div>

        <p className="border-t border-orb-line/70 pt-4 text-sm text-orb-gray">
          <span className="font-medium text-orb-white">Or set it up by hand.</span> Pick the AI you use and follow the steps.
        </p>

        <div role="tablist" aria-label="Which AI you use" className="flex flex-wrap gap-1 rounded-[13px] border border-orb-line p-1">
          {CLIENTS.map((client) => {
            const Icon = client.icon;
            return (
              <button
                key={client.id}
                type="button"
                role="tab"
                id={`ai-tab-${client.id}`}
                aria-selected={clientTab === client.id}
                aria-controls={`ai-panel-${client.id}`}
                onClick={() => setClientTab(client.id)}
                className={cn(
                  "flex min-w-0 flex-1 basis-40 items-center justify-center gap-2 whitespace-nowrap rounded-[9px] px-3 py-1.5 text-compact font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
                  clientTab === client.id ? "bg-orb-raised text-orb-white" : "text-orb-muted hover:text-orb-white",
                )}
              >
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                {client.label}
              </button>
            );
          })}
        </div>

        <div role="tabpanel" id={`ai-panel-${clientTab}`} aria-labelledby={`ai-tab-${clientTab}`}>
          {clientTab === "app" && (
            <Steps>
              <li>
                In Claude.ai or Claude Desktop, open <span className="text-orb-white">Settings → Connectors → Add custom connector</span>.
                In ChatGPT, add a custom connector the same way.
              </li>
              <li>
                Name it <span className="text-orb-white">Orbik</span> and paste this URL:
                <PasteBlock label="Connector URL" text={endpointUrl} />
              </li>
              <li>Save it and connect. You come back here to sign in, choose which workspaces it may read, and say whether it may write. No token needed.</li>
            </Steps>
          )}

          {clientTab === "claude-code" && (
            <Steps>
              <li>
                Run this in your terminal:
                <PasteBlock label="Terminal" text={`claude mcp add --transport http orbik ${endpointUrl}`} />
              </li>
              <li>
                In Claude Code, type <code className="font-mono text-orb-white">/mcp</code>, pick <span className="text-orb-white">orbik</span> and sign in.
                You come back here to choose which workspaces it may read, and say whether it may write. No token needed.
              </li>
            </Steps>
          )}

          {clientTab === "token" && (issued ? (
            <ConnectInstructions issued={issued} endpointUrl={endpointUrl} onDone={() => setIssued(null)} />
          ) : (
            <form onSubmit={connect} className="space-y-4">
              <p className="text-sm leading-relaxed text-orb-gray">
                For Cursor, other editors and agents you build. Create a token, then paste what the next screen shows into your tool. You see the token once.
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-56 flex-1 space-y-1.5">
                  <Label htmlFor="mcp-token-name" className="text-xs text-orb-gray">Name this connection</Label>
                  <Input
                    id="mcp-token-name"
                    value={name}
                    maxLength={60}
                    placeholder="Cursor on my laptop"
                    onChange={(event) => {
                      setName(event.target.value);
                      setActionError(null);
                    }}
                  />
                </div>
                <Button type="submit" size="sm" className="h-9" disabled={creating || !name.trim()}>
                  {creating ? "Creating…" : "Create token"}
                </Button>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <fieldset className="space-y-2" disabled={creating}>
                  <legend className="mb-2 text-xs font-medium text-orb-gray">What it reads</legend>
                  <Choice name="mcp-token-reach" value="this" checked={reach === "this"} onChange={() => setReach("this")}>
                    This workspace only
                  </Choice>
                  <Choice name="mcp-token-reach" value="all" checked={reach === "all"} onChange={() => setReach("all")}>
                    All workspaces I can read, including ones I create or join later
                  </Choice>
                </fieldset>
                <div className="space-y-2">
                  <p className="text-xs font-medium text-orb-gray">What it may do</p>
                  <label className={cn("flex items-start gap-2.5 rounded-lg border border-orb-line px-3 py-2.5 text-sm", mayAskToWrite ? "cursor-pointer hover:border-orb-muted/60" : "opacity-70", write && mayAskToWrite && "border-orb-lime/50 bg-orb-lime/5")}>
                    <input
                      type="checkbox"
                      name="mcp-token-write"
                      className="mt-0.5 accent-orb-lime"
                      checked={write && mayAskToWrite}
                      disabled={creating || !mayAskToWrite}
                      onChange={(event) => setWrite(event.target.checked)}
                    />
                    <span className="space-y-0.5">
                      <span className="block text-orb-white">May write to the Library</span>
                      {writeBlocked && (
                        <span className="block text-xs text-orb-coral" data-testid="mcp-write-blocked">{writeBlocked}</span>
                      )}
                      <span className="block text-xs leading-relaxed text-orb-muted">
                        It can save what you ask — inside your top-level folders, never in Sources or anything you locked — as you.
                        What it adds is kept from Orbik&apos;s agents, and every file keeps its earlier versions.
                      </span>
                    </span>
                  </label>
                </div>
              </div>
            </form>
          ))}
        </div>

        <div className="border-t border-orb-line/70 pt-4">
          <p className="text-sm text-orb-gray">
            <span className="font-medium text-orb-white">Then try it.</span> Paste this into a new chat to check it is connected:
          </p>
          <PasteBlock label="Prompt" text={firstPrompt(workspaceName)} />
        </div>
      </Panel>

      <Panel>
        <PanelTitle aside={<span className="text-xs text-orb-muted">{activeCount ? `${activeCount} active` : null}</span>}>Connected</PanelTitle>
        {grants.length || tokens.length ? (
          <RowList aria-label="What reads this workspace">
            {grants.map((grant) => (
              <CredentialRow
                key={grant.id}
                kind="app"
                name={grant.clientName}
                credential={grant}
                endedLabel="Disconnected"
                action={grant.status === "active" && (
                  <Button type="button" variant="ghost" size="sm" className="text-orb-muted" title="Stops this app in every workspace it reads" onClick={() => disconnect(grant.id)}>
                    {readsSeveral(grant.reads) ? "Disconnect everywhere" : "Disconnect"}
                  </Button>
                )}
              />
            ))}
            {tokens.map((token) => (
              <CredentialRow
                key={token.id}
                kind="token"
                name={token.name}
                credential={token}
                endedLabel="Revoked"
                action={token.status === "active" && (
                  <Button type="button" variant="ghost" size="sm" className="text-orb-muted" title="Stops this token in every workspace it reads" onClick={() => revoke(token.id)}>
                    {readsSeveral(token.reads) ? "Revoke everywhere" : "Revoke"}
                  </Button>
                )}
              />
            ))}
          </RowList>
        ) : (
          <p className="rounded-lg border border-dashed border-orb-line px-4 py-5 text-center text-sm text-orb-muted">
            Nothing reads this workspace yet. Connect Orbik MCP above and it shows up here.
          </p>
        )}
        <p className="mt-3 text-xs leading-relaxed text-orb-muted">
          It writes to the Library only if you allowed it, as you, with every change in the file&apos;s history, and it cannot
          start an agent. Revoking stops it on its next request in every workspace it reads.
        </p>
      </Panel>
    </div>
  );
}

/** The ways in, as the card's tabs name them. Claude's apps, ChatGPT and Claude Code sign in; the rest take a token. */
const CLIENTS = Object.freeze([
  { id: "app", label: "Claude.ai or ChatGPT", icon: AppWindow },
  { id: "claude-code", label: "Claude Code", icon: TerminalSquare },
  { id: "token", label: "Cursor and others", icon: KeyRound },
]);

/**
 * A first question to ask once connected: it proves the connection reads this workspace, and shows
 * somebody what kind of question it is for. Named by the workspace, because a connection may read
 * several and would otherwise ask which one.
 */
function firstPrompt(workspaceName) {
  const which = workspaceName ? `the ${workspaceName} knowledge base` : "this workspace's knowledge base";
  return `Use Orbik to read ${which}. Start with its index, then tell me in five bullet points what the company sells, who it sells to and what sets it apart. Cite the pages you used.`;
}

/**
 * A prompt that has the person's own AI connect Orbik for them: an agent that can add an MCP server
 * (Claude Code, Cursor and the like) does it, and a chat app that cannot (Claude.ai, ChatGPT) walks
 * them through its own settings instead. It names the URL in full and says sign-in needs no token,
 * so nothing has to be looked up elsewhere; the manual steps below it say the same by hand.
 */
function connectPrompt(endpointUrl, workspaceName) {
  const which = workspaceName ? `the ${workspaceName} knowledge base` : "my workspace's knowledge base";
  return [
    `Connect Orbik's MCP server so you can read ${which}.`,
    "",
    "Name: orbik",
    `URL: ${endpointUrl}`,
    "Transport: Streamable HTTP. It signs in with OAuth, so no token or API key is needed.",
    "",
    `- If you can add MCP servers yourself (Claude Code, Cursor or another coding agent), add it now. In Claude Code, run: claude mcp add --transport http orbik ${endpointUrl} — then tell me to type /mcp and sign in to orbik.`,
    "- If you cannot (Claude.ai, Claude Desktop, ChatGPT), give me the exact clicks in this app to add a custom connector named Orbik with that URL.",
    "- If my client cannot sign in with OAuth, tell me to create a token in Orbik under Settings → Orbik MCP → Cursor and others.",
    "",
    "Signing in opens Orbik, where I choose which workspaces you may read. Once connected, read the knowledge base's index and tell me in one line what the company does.",
  ].join("\n");
}

/** Numbered steps, with room under each for what to paste. */
function Steps({ children }) {
  return <ol className="list-decimal space-y-3 pl-5 text-sm leading-relaxed text-orb-gray marker:text-orb-muted">{children}</ol>;
}

/**
 * Text a person pastes elsewhere, shown in full — never truncated behind a button — with the button
 * that copies it.
 */
function PasteBlock({ label, text }) {
  return (
    <div className="mt-2 min-w-0 rounded-lg border border-orb-line bg-orb-space/80">
      <div className="flex items-center justify-between gap-2 border-b border-orb-line/70 px-3 py-1.5">
        <span className="text-2xs text-orb-muted">{label}</span>
        <CopyButton text={text} label="Copy" />
      </div>
      <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-orb-white">{text}</pre>
    </div>
  );
}

/**
 * One app or token that reads this workspace: what it is, what it may do and read, when it was last
 * used, and the button that stops it.
 */
function CredentialRow({ kind, name, credential, endedLabel, action }) {
  const ended = credential.status !== "active";
  const Icon = kind === "app" ? AppWindow : KeyRound;
  return (
    <li className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 sm:px-4", ended && "opacity-60")}>
      <span aria-hidden="true" className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg border border-orb-line", kind === "app" ? "text-orb-cyan" : "text-orb-lime")}>
        <Icon className="size-4" />
      </span>
      <span className="min-w-[11rem] flex-1">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 break-words text-sm font-medium text-orb-white">{name}</span>
          <Pill tone="muted">{kind === "app" ? "App" : "Token"}</Pill>
          <Pill tone={mcpApi.mayWrite(credential) ? "orange" : "neutral"}>{mcpApi.mayWrite(credential) ? "Read and write" : "Read only"}</Pill>
          {ended && <Pill tone="muted">{endedLabel}</Pill>}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-orb-muted">
          <span>{capitalised(describeReads(credential.reads))}</span>
          <span aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={cn("size-1.5 rounded-full", credential.lastUsedAt && !ended ? "bg-orb-lime" : credential.lastUsedAt ? "bg-orb-muted" : "border border-orb-muted")} />
            {describeLastUse(credential)}
          </span>
        </span>
      </span>
      {action}
    </li>
  );
}

/** One radio choice, drawn as a bordered option that lights up when chosen. */
function Choice({ name, value, checked, onChange, children }) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm transition-colors", checked ? "border-orb-lime/50 bg-orb-lime/5 text-orb-white" : "border-orb-line text-orb-gray hover:border-orb-muted/60")}>
      <input type="radio" name={name} value={value} className="mt-0.5 accent-orb-lime" checked={checked} onChange={onChange} />
      <span>{children}</span>
    </label>
  );
}

/**
 * Shows a freshly minted token and exactly what to paste where.
 *
 * One snippet per client, behind tabs, because the four clients take four shapes and a person who
 * has to translate a `curl` example into their editor's configuration is a person who will get it
 * wrong once and give up. The token is repeated in full in each rather than left as a placeholder:
 * it is visible once, and assembling it by hand is where it gets truncated. Each snippet has its
 * own copy button.
 *
 * Exported for the Home page's "Connect Orbik MCP" step, which mints a token inline and shows the
 * same instructions, so the two places can never tell somebody to paste different things.
 */
export function ConnectInstructions({ issued, endpointUrl, onDone }) {
  const snippets = [
    {
      id: "claude-code",
      label: "Claude Code",
      code: `claude mcp add --transport http orbik ${endpointUrl} \\\n  --header "Authorization: Bearer ${issued.secret}"`,
    },
    {
      id: "mcp-json",
      label: "Cursor and editors",
      hint: ".mcp.json",
      code: JSON.stringify({ mcpServers: { orbik: { type: "http", url: endpointUrl, headers: { Authorization: `Bearer ${issued.secret}` } } } }, null, 2),
    },
    {
      id: "anthropic",
      label: "Anthropic API",
      hint: "Messages API",
      code: JSON.stringify(
        {
          mcp_servers: [{ type: "url", url: endpointUrl, name: "orbik", authorization_token: issued.secret }],
          tools: [{ type: "mcp_toolset", mcp_server_name: "orbik" }],
        },
        null,
        2,
      ),
    },
    {
      id: "openai",
      label: "OpenAI API",
      hint: "Responses API",
      code: JSON.stringify({ type: "mcp", server_label: "orbik", server_url: endpointUrl, authorization: issued.secret, require_approval: "never" }, null, 2),
    },
  ];
  const [tab, setTab] = useState(snippets[0].id);
  const shown = snippets.find((snippet) => snippet.id === tab) ?? snippets[0];

  return (
    <div className="space-y-4 rounded-xl border border-orb-lime/40 bg-orb-lime/[0.04] p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-orb-lime/15 text-orb-lime">
          <Check className="size-4" />
        </span>
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-semibold text-orb-white">Your token, shown once</p>
          <p className="text-xs leading-relaxed text-orb-gray">{issued.notice}</p>
        </div>
      </div>

      <div className="flex min-w-0 items-center gap-2 rounded-lg border border-orb-line bg-orb-space/80 p-1.5 pl-3">
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-orb-white">{issued.secret}</code>
        <CopyButton text={issued.secret} label="Copy token" />
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-orb-gray">Paste into your client</p>
        <div role="tablist" aria-label="Clients" className="flex gap-1 overflow-x-auto">
          {snippets.map((snippet) => (
            <button
              key={snippet.id}
              type="button"
              role="tab"
              id={`connect-tab-${snippet.id}`}
              aria-selected={snippet.id === shown.id}
              aria-controls="connect-snippet"
              onClick={() => setTab(snippet.id)}
              className={cn(
                "shrink-0 whitespace-nowrap rounded-md border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
                snippet.id === shown.id ? "border-orb-line bg-orb-raised text-orb-white" : "border-transparent text-orb-muted hover:text-orb-white",
              )}
            >
              {snippet.label}
            </button>
          ))}
        </div>
        <div id="connect-snippet" role="tabpanel" aria-labelledby={`connect-tab-${shown.id}`} className="relative rounded-lg border border-orb-line bg-orb-space/80">
          <div className="flex items-center justify-between gap-2 border-b border-orb-line/70 px-3 py-1.5">
            <span className="text-2xs text-orb-muted">{shown.hint ?? "Terminal"}</span>
            <CopyButton text={shown.code} label="Copy" />
          </div>
          <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed text-orb-white">{shown.code}</pre>
        </div>
      </div>

      <p className="text-xs leading-relaxed text-orb-muted">
        Claude.ai, Claude Desktop and ChatGPT do not take a pasted token. Add{" "}
        <span className="break-all font-medium text-orb-gray">{endpointUrl}</span> as a custom connector instead:
        they will send you back here to sign in, choose which workspaces they may read, and say
        whether they may write to the Library.
      </p>

      <Button type="button" size="sm" onClick={onDone}>
        I&apos;ve saved it
      </Button>
    </div>
  );
}

/** A sentence's first letter in capitals. */
function capitalised(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/**
 * Says what a token or an approved app reads, as the server reports it.
 *
 * Every credential on this card reads this workspace, so a set of one is "this workspace" and a
 * longer one names the others, a few at a time.
 */
function describeReads(reads) {
  if (!reads) return "reads this workspace";
  if (reads.mode === "all") return "reads every workspace you can read";
  const names = reads.workspaces.map((workspace) => workspace.name);
  if (names.length <= 1) return "reads this workspace";
  const shown = names.slice(0, 3).join(", ");
  return `reads ${names.length} workspaces: ${shown}${names.length > 3 ? ", …" : ""}`;
}

/**
 * Why a token minted with this reach may not write, or null when it may. Writing needs member or
 * above on every workspace the token covers; a read-only role on any of them rules it out.
 */
function writeRefusal(workspaces, workspaceId, reach) {
  const here = workspaces.find((workspace) => workspace.id === workspaceId);
  if (here && !can(roleOf(here), "member")) return "Your role in this workspace is read-only, so a token can only read it.";
  if (reach === "all" && workspaces.some((workspace) => !can(roleOf(workspace), "member"))) {
    return "You are read-only in at least one of your workspaces, so a token for all of them can only read. Choose this workspace only to allow writing.";
  }
  return null;
}

/** What a token or an approved app may do: read, or read and write to the Library. */
function describeAccess(credential) {
  return mcpApi.mayWrite(credential) ? "Read and write access" : "Read access";
}

/** Whether revoking a credential stops it somewhere other than this workspace too. */
function readsSeveral(reads) {
  return reads?.mode === "all" || (reads?.workspaces?.length ?? 0) > 1;
}

/**
 * Says when a token was last used.
 *
 * "Never used" said plainly, because it is the useful half of this line: a token nothing has ever
 * presented is either one somebody pasted wrongly or one they forgot to use, and both call for
 * revoking it.
 */
function describeLastUse(token) {
  return token.lastUsedAt ? `last used ${formatDate(token.lastUsedAt)}` : "never used";
}

/** A date a person reads, in their own locale, without a time they did not ask for. */
function formatDate(value) {
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** The MCP endpoint on the API this app already talks to. Shared with the Home page. */
export function defaultEndpointUrl() {
  return `${getApiBaseUrl()}/mcp`;
}
