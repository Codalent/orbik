# Grok

Add Orbik to Grok as a custom connector, then sign in to Orbik to choose which workspaces it may read
and whether it may write.

Grok reaches Orbik from xAI's servers and refuses a local or private address, so the install must be
on an HTTPS address the internet can reach: put it on a domain first
([A domain with HTTPS](../self-hosting/https.md)) and check it as in
[On a server with HTTPS](README.md#on-a-server-with-https).

## Add the connector

1. Open [grok.com/connectors](https://grok.com/connectors), press **New Connector** and choose
   **Custom**.
2. Enter your MCP URL, such as `https://orbik.example.com/mcp`. The workspace's **Settings → Orbik
   MCP** page shows yours. Orbik signs in with OAuth, so there is no token or API key to enter.
3. Connect it. Grok sends you to Orbik in your browser.
4. Approve it on Orbik's consent screen: choose the workspaces it may read and whether it may write,
   then press **Allow**. The screen is the same one Claude gets; see
   [Approve it in Orbik](claude.md#approve-it-in-orbik).

On Grok Business and Enterprise a team admin adds the connector first, in the xAI console under
**Grok Business → Connectors → Add Connector → Other**, with the same URL; members then connect it
on grok.com and each signs in to Orbik as themselves.

## Try it

```text
Use Orbik to read the Example knowledge base. Start with its index, then tell me in five bullet
points what the company sells, who it sells to and what sets it apart. Cite the pages you used.
```

## Change or remove it

To change which workspaces Grok reads, or whether it may write, connect it again and approve the
new choice; it replaces the old one. To stop it, open **Settings → Orbik MCP** in any workspace it
reads and press **Disconnect** under **Connected**.
