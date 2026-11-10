# Usage statistics

Orbik can send one small anonymous ping a day so its maintainers can tell how many installs there
are and what they use. It is off unless you turn it on.

## Turning it on

With your permission, the scheduler sends one small JSON document a day to
`https://telemetry.orbik.io/v1/ping`. It is **off** unless you turn it on, and the scheduler says
which in its log when it starts:

```sh
ORBIK_TELEMETRY=on
```

## What it sends

This is all it sends — every ping is also written to the scheduler's log (`telemetry.sending`):

```json
{
  "installId": "a random id made for this install, kept in its database",
  "version": "0.1.0",
  "node": "24.14.0",
  "sentAt": "2026-10-31T15:56:16.312Z",
  "counts": {
    "workspaces": 5,
    "crawlRuns30d": 1,
    "pagesFetched30d": 79,
    "agentRuns30d": { "business-knowledge-base": 2 }
  },
  "services": {
    "anthropic": true,
    "openaiEmbeddings": true,
    "chrome": true,
    "extensions": 0
  }
}
```

No page, address, hostname, workspace name, email or key is read into it. The code that builds it
is [`agents/src/telemetry.js`](../../agents/src/telemetry.js).
