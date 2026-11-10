# Cursor and other clients

Connect Cursor, other editors, the Anthropic and OpenAI APIs or an agent you built with a token, sent
as a bearer header to your MCP URL.

## Make a token

1. Open the workspace's **Settings → Orbik MCP** and choose **Cursor and others**.
2. Name the connection, such as "Cursor on my laptop".
3. Under **What it reads**, choose **This workspace only** or **All workspaces I can read, including
   ones I create or join later**.
4. Tick **May write to the Library** only if the client should save things for you.
5. Press **Create token**.

Orbik shows the token once, starting with `orbm_`, beside what to paste for **Claude Code**, **Cursor
and editors**, the **Anthropic API** and the **OpenAI API**, each with the token already in it. Copy
what you need before you press **I've saved it**: Orbik keeps only a hash and cannot show it again.

## Cursor and editors

Add Orbik to your editor's MCP configuration:

```json
{
  "mcpServers": {
    "orbik": {
      "type": "http",
      "url": "https://orbik.example.com/mcp",
      "headers": {
        "Authorization": "Bearer orbm_…"
      }
    }
  }
}
```

## Anthropic Messages API

Give the request the server and its tools:

```json
{
  "mcp_servers": [
    {
      "type": "url",
      "url": "https://orbik.example.com/mcp",
      "name": "orbik",
      "authorization_token": "orbm_…"
    }
  ],
  "tools": [{ "type": "mcp_toolset", "mcp_server_name": "orbik" }]
}
```

## OpenAI Responses API

Add Orbik as one of the request's tools:

```json
{
  "type": "mcp",
  "server_label": "orbik",
  "server_url": "https://orbik.example.com/mcp",
  "authorization": "orbm_…",
  "require_approval": "never"
}
```

## Any other MCP client

Orbik's MCP server speaks Streamable HTTP at your MCP URL and wants the token as
`Authorization: Bearer orbm_…` on every request. Nothing is held between requests, so there is no
session to keep open: each request is answered on its own. To see what a token is offered, ask for
the tool list:

```sh
curl -s https://orbik.example.com/mcp \
  -H "Authorization: Bearer orbm_…" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

A request without a valid token is answered `401`, with a `WWW-Authenticate` header that points a
client able to sign in at Orbik's OAuth documents. A token may make 120 requests a minute.

## Resources

A client that attaches files to a conversation, rather than calling tools, can read the site's
llms.txt at `orbik://llms.txt`, the design system at `orbik://brand` and `orbik://brand/tokens.json`,
and a Library file at `orbik://library/` followed by its path. A token that reads several workspaces
reads them under `orbik://w/<workspace id>/` instead. The full list is in the
[MCP tool reference](tools.md#resources).
