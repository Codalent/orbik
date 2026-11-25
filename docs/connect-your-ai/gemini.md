# Gemini

Add Orbik to the Gemini app as a custom app, then sign in to Orbik to choose which workspaces it may
read and whether it may write.

Gemini reaches Orbik from Google's servers, so the install must be on an HTTPS address the internet
can reach: put it on a domain first ([A domain with HTTPS](../self-hosting/https.md)) and check it
as in [On a server with HTTPS](README.md#on-a-server-with-https).

> [!NOTE]
> Google offers custom apps only to some accounts for now: a personal Google account (not a work or
> school one), of someone 18 or over in the US, with Gemini's History on, in English. Google's help
> page [Connect & manage custom apps](https://support.google.com/gemini/answer/17209137) says who
> can use them today.

## Add the custom app

1. On a computer, open [gemini.google.com](https://gemini.google.com) and go to **Settings →
   Connected Apps**. If there is no **Connected Apps**, it is under **Personal Intelligence**.
   Custom apps are added in the web app; once added, they work in the mobile app too.
2. Under **Custom apps**, choose **Add a custom app** and enter your MCP URL, such as
   `https://orbik.example.com/mcp`. The workspace's **Settings → Orbik MCP** page shows yours.
3. Press **Next**. Gemini registers itself with Orbik, so leave the credentials under **Advanced
   features** empty: there is no client ID, token or API key to enter. Gemini sends you to Orbik in
   your browser.
4. Approve it on Orbik's consent screen: choose the workspaces it may read and whether it may write,
   then press **Allow**. The screen is the same one Claude gets; see
   [Approve it in Orbik](claude.md#approve-it-in-orbik).

## Try it

```text
Use Orbik to read the Example knowledge base. Start with its index, then tell me in five bullet
points what the company sells, who it sells to and what sets it apart. Cite the pages you used.
```

## Change or remove it

To change which workspaces Gemini reads, or whether it may write, connect it again and approve the
new choice; it replaces the old one. To stop it, open **Settings → Orbik MCP** in any workspace it
reads and press **Disconnect** under **Connected**, or remove the custom app in Gemini's
**Connected Apps**.
