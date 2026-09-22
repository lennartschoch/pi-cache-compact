<div align="center">

# 🗜️ pi-cache-compact

**Cache-friendly context compaction for [Pi](https://pi.dev).**

A port of [opencode-cache-compact](https://github.com/lennartschoch/opencode-cache-compact),
adapted to Pi's extension API.

For locally hosted models, where prefilling a large context is the expensive part.

[Install](#install) · [Configure](#configure) · [How it works](#how-it-works) · [Caveats](#caveats) · [Develop](#develop)

[![npm](https://img.shields.io/npm/v/pi-cache-compact?color=8B5CF6&style=flat-square)](https://www.npmjs.com/package/pi-cache-compact)
![tests](https://img.shields.io/badge/tests-19-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

</div>

---

## Why

Pi's built-in compaction writes the summary with a brand-new request: its own
system prompt, no tools, and the transcript re-serialized into a single user
message. On a locally hosted model with prefix caching that can never reuse the
KV cache, so the whole conversation is re-prefilled just to produce the summary.
On a 100k-token session at ~200 tok/s that is minutes of silence.

This extension leaves Pi's trigger and cut alone and replaces only the
summarization call:

1. **Reuse the live prefix.** It asks for the handoff summary as a strict
   continuation of the conversation — the same system prompt, the same tool
   declarations, the same messages — followed by one user turn asking for the
   summary. A prefix-caching server serves everything but that short ask from
   cache, so only the summary is generated.
2. **Let Pi do the rest.** Pi still decides when to compact, still keeps the
   recent tail, and still appends the compaction entry. The extension hooks
   `session_before_compact` and returns the summary it wrote.
3. **Fail safe.** If the summary comes back empty, truncated, or as a tool call,
   the extension returns nothing and Pi's default summary runs instead.

## Install

Requires Pi with the `session_before_compact` extension hook (tested against
`@earendil-works/pi-coding-agent` 0.87.0). No build step — Pi loads the
TypeScript extension directly.

```bash
pi install npm:pi-cache-compact
# or try it for one run
pi -e npm:pi-cache-compact
```

## Configure

Options are read from JSON, merged with the project file winning:

1. `<agent-dir>/cache-compact.json` (personal; `~/.pi/agent` by default)
2. `<cwd>/.pi/cache-compact.json` (project)

```json
{
  "models": ["local/qwen3-coder"],
  "summaryMaxTokens": 2048
}
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Disable the extension entirely. |
| `models` | string[] | `[]` (all) | Only act on these `provider/modelId`s. Scope it to your local endpoint. |
| `summaryModel` | `{ provider, id }` | active model | Summarize with a different (e.g. cheaper) model. |
| `summaryPrompt` | string | [see `src/build.ts`](src/build.ts) | Replace the handoff instruction. |
| `summaryMaxTokens` | number | `2048` | Cap on the summary's output tokens. |
| `cacheRetention` | `"none" \| "short" \| "long"` | `"short"` | Cache retention for the summary request. |
| `toolChoice` | `"none" \| "auto"` | `"none"` | Forbid tool calls in the summary reply; tools are still declared for the prefix. |
| `debug` | boolean | `false` | Log decisions to stderr. |

## How it works

Pi computes the context size from the last reported usage and compacts when it
crosses `contextWindow - reserveTokens`. That fires `session_before_compact`,
where an extension can supply its own summary.

The extension builds the summary request from the span Pi is about to **drop** —
everything in the projection before `firstKeptEntryId`. That span is a prefix of
the live transcript, so the same system prompt, tools and messages are reused
from the prefix cache; only the short ask is prefilled. It appends the ask and
calls `ctx.modelRegistry.complete(...)`, and Pi persists the returned summary as
a normal `CompactionEntry` while keeping its own tail.

Summarizing only the dropped span matters: a whole-context summary would cover
the messages Pi keeps verbatim too, so `summary + kept tail` could be larger than
what it replaced and the context would grow on every compaction.

The e2e test proves this from the recorded HTTP bodies: the summary request keeps
the conversation's system prompt, declares the same tools, and (minus the ask) is
an exact prefix of the previous agent request — the kept tail is not resent.

## Caveats

- The first request after any compaction still prefills
  `[system][summary][kept…]`, since that becomes the new shared prefix. This
  extension only removes the extra full re-read that Pi's default summary
  performs.
- How much context compaction reclaims is Pi's `keepRecentTokens` setting: it
  keeps that many recent tokens verbatim. If it is close to (or larger than)
  `contextWindow - reserveTokens`, Pi drops little and compaction barely helps —
  lower it for small-context local models. Set it well below `contextWindow -
  reserveTokens` and each compaction replaces the dropped span with a short
  summary.
- `toolChoice: "none"` is ignored by some providers; if the model calls a tool
  anyway the reply is rejected and Pi's default summary runs.
- The summary must reuse the exact system prompt and tool declarations. If
  another extension rewrites the request via `context`/`context_with_system`,
  the reconstructed prefix may no longer match (Pi's default will still be
  correct, just cold).

## Develop

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # unit tests (node --test; Node 24+ runs TypeScript directly)
npm run test:e2e    # real `pi --print` + a mock model server (opt-in)
```

`npm run test:e2e` spawns Pi against a mock OpenAI-compatible server that records
request bodies, then asserts the summary request is a cache-hit continuation and
that Pi persisted it. It needs no network or credentials.

### Layout

```
src/
├── extension.ts   # the extension: session_before_compact handler
├── build.ts       # pure: summary ask, tool declarations, request assembly
└── config.ts      # pure-ish: option parsing and file loading
test/
├── build.test.ts       # pure helpers
├── config.test.ts      # option parsing/merging
├── extension.test.ts   # handler with a mock Pi context
└── e2e.test.ts         # real Pi + mock model server
```

## License

[MIT](LICENSE).
