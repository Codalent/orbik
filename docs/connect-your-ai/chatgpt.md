# ChatGPT

Add Orbik to ChatGPT as a connector, then sign in to Orbik to choose which workspaces it may read and
whether it may write.

ChatGPT reaches Orbik from OpenAI's servers, so the install must be on an HTTPS address the
internet can reach: put it on a domain first ([A domain with HTTPS](../self-hosting/https.md)) and
check it as in [On a server with HTTPS](README.md#on-a-server-with-https).

## Add the connector

1. In ChatGPT's settings, add a custom connector named **Orbik** with your MCP URL, such as
   `https://orbik.example.com/mcp`. The workspace's **Settings → Orbik MCP** page shows yours.
   Orbik signs in with OAuth, so there is no token or API key to enter.
2. Connect it. ChatGPT sends you to Orbik in your browser.
3. Approve it on Orbik's consent screen: choose the workspaces it may read and whether it may write,
   then press **Allow**. The screen is the same one Claude gets; see
   [Approve it in Orbik](claude.md#approve-it-in-orbik).

ChatGPT keeps one connection per URL, so choose every workspace you want it to read in this one
approval.

## What ChatGPT reads with

ChatGPT's deep research and company knowledge look for two tools, `search` and `fetch`, in a shape
of their own, and Orbik offers both:

- `search` finds the pages and Library files that answer a question, by meaning, and returns up to
  ten, each with an id, a title and a link. On a connection that reads several workspaces it searches
  all of them unless told which, and each title ends with the workspace's name.
- `fetch` opens one of them in full, by its id.

The rest of Orbik's tools are there too, for ChatGPT to call where it can: `content_search`, which
returns the passages themselves, the Library tools and the brand tools. They are all in the
[MCP tool reference](tools.md).

## Try it

```text
Use Orbik to read the Example knowledge base. Start with its index, then tell me in five bullet
points what the company sells, who it sells to and what sets it apart. Cite the pages you used.
```

## Change or remove it

To change which workspaces ChatGPT reads, or whether it may write, connect it again and approve the
new choice; it replaces the old one. To stop it, open **Settings → Orbik MCP** in any workspace it
reads and press **Disconnect** under **Connected**.
