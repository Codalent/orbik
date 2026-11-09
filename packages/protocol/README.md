# @orbik/protocol

The vocabulary the API and the agent workers have to agree on.

It has **no dependencies**, deliberately. Anything that needs a database handle belongs in
`@orbik/core` or a domain package instead.

Everything here is a *parser*, not a type declaration. A
definition read from a collection, and a request body from a browser are all untrusted input, and
the only way that stays true is if the thing that names the shape is also the thing that enforces
it.

## What is in here

| Module | Owns |
|---|---|
| `runStatus.js` | Run lifecycle states and the allow-list of legal transitions |
| `agentDefinition.js` | The shape of a versioned, cloud-owned agent definition |
| `agentEvent.js` | The progress events a runtime emits while working |
| `validate.js` | Shared validation primitives and `ProtocolError` |

## Naming: run vs job

Two words have settled meanings across the repository, and this package keeps them:

| Word | Means |
|---|---|
| **run** | one agent execution a person reasons about (`agent_runs`) |
| **job** | one unit of work a worker claims (`agent_jobs`) |

A crawl of 50,000 URLs is one run and thousands of jobs. A run that finished with a result is
`succeeded`, never `completed`, so runs and jobs share one vocabulary. See
[agents/README.md](../../agents/README.md#runs-and-jobs) for how the two relate, and
[docs/ai-execution.md](../../docs/ai-execution.md) for how a run executes.

## Validation style

Parsers follow the convention in `@orbik/core`'s `env.js`: collect every failure into a list, then
throw one aggregated `ProtocolError` naming all of them. A caller fixing a malformed definition
should see everything wrong with it at once, not one problem per attempt.

Parsers **rebuild** their result from an allow-list rather than filtering the input, so an
unrecognized field cannot survive the parse.
