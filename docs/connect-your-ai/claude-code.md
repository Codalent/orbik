# Claude Code

Add Orbik to Claude Code with one command, then sign in through your browser or use a token.

## Sign in

```sh
claude mcp add --transport http orbik https://orbik.example.com/mcp
```

Use your own MCP URL, such as `http://localhost:8080/mcp` for a Docker install on your machine; the
workspace's **Settings → Orbik MCP** page shows it.

Then, in Claude Code, type `/mcp`, pick **orbik** and sign in. Orbik opens in your browser: choose
the workspaces Claude Code may read and whether it may write to the Library, then press **Allow**
([what the consent screen asks](claude.md#approve-it-in-orbik)). No token is involved.

## With a token

For a machine where signing in through a browser is awkward, use a token instead. On **Settings →
Orbik MCP**, choose **Cursor and others**, name the connection, choose what it reads and whether it
may write, and press **Create token**. Orbik then shows the command with the token in it:

```sh
claude mcp add --transport http orbik https://orbik.example.com/mcp \
  --header "Authorization: Bearer orbm_…"
```

The token is shown once. Copy the command before you leave the page.

## Use it

Ask Claude Code to use Orbik, and it calls Orbik's tools, which it names `mcp__orbik__` followed by
the tool, such as `mcp__orbik__content_search`. A good first question:

```text
Use Orbik to read the Example knowledge base. Start with its index, then tell me in five bullet
points what the company sells, who it sells to and what sets it apart. Cite the pages you used.
```

If the connection may write, ask it to save something — "save these two bios to Orbik" — and it
writes a Library file as you, inside one of your top-level folders, and says which path it wrote.
See [Letting it write](README.md#letting-it-write).
