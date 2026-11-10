# Claude.ai and Claude Desktop

Add Orbik to Claude as a custom connector, then sign in to Orbik to choose which workspaces Claude may
read and whether it may write.

Claude reaches Orbik from Anthropic's servers, so the install must be on an HTTPS address the
internet can reach: put it on a domain first ([A domain with HTTPS](../self-hosting/https.md)) and
check it as in [On a server with HTTPS](README.md#on-a-server-with-https). For an install on your
own machine, use [Claude Code](claude-code.md) instead.

## Add the connector

1. In Claude.ai or Claude Desktop, open **Settings → Connectors → Add custom connector**.
2. Name it **Orbik** and paste your MCP URL, such as `https://orbik.example.com/mcp`. The
   workspace's **Settings → Orbik MCP** page shows yours.
3. Save it and connect. Claude sends you to Orbik in your browser. There is no token to paste.

## Approve it in Orbik

Sign in to Orbik if it asks. The consent screen asks whether to let Claude read your knowledge base,
says what it will be able to do, and says how the app is identified: by an address it proved it
controls, or, for an app that registered itself, with a warning that its name is not verified.
Approve only if you just started this from Claude.

1. Under **Which workspaces may it read?**, choose **All workspaces I can read, including ones I
   create or join later**, or **Only these** and tick them. With one workspace, it reads that one.
2. Tick **Allow this app to write to the Library** only if Claude should save things for you. It is
   off by default, even when the app asked for it.
3. Press **Allow**. You are sent back to Claude, connected.

Claude keeps one connection per URL, so choose every workspace you want it to read in this one
approval. With several, Claude names a workspace on each call; see
[One workspace or several](README.md#one-workspace-or-several).

## Try it

In a new chat, ask:

```text
Use Orbik to read the Example knowledge base. Start with its index, then tell me in five bullet
points what the company sells, who it sells to and what sets it apart. Cite the pages you used.
```

Replace Example with the workspace's name. Claude should call `library_tree`, read the index and
answer with links to the pages it used.

## Change or remove it

To change which workspaces Claude reads, or whether it may write, connect it again from Claude and
approve the new choice; it replaces the old one. To stop it, open **Settings → Orbik MCP** in any
workspace it reads and press **Disconnect** under **Connected**: it stops everywhere on its next
request.
