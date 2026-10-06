<div align="center">

# 🗜️ pi-cache-compact

**Cache-friendly context compaction for [Pi](https://pi.dev).**

A port of [opencode-cache-compact](https://github.com/lennartschoch/opencode-cache-compact),
adapted to Pi's extension API.

For locally hosted models, where prefilling a large context is the expensive part.

[Install](#install) · [Configure](#configure) · [How it works](#how-it-works) · [Caveats](#caveats) · [Develop](#develop)

[![npm](https://img.shields.io/npm/v/pi-cache-compact?color=8B5CF6&style=flat-square)](https://www.npmjs.com/package/pi-cache-compact)
![tests](https://img.shields.io/badge/tests-79-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

</div>

---

## Why

Pi's built-in compaction writes the summary with a brand-new request: its own
system prompt, no tools, and the transcript re-serialized into a single user
message. Two consequences:

1. **It can never reuse the conversation's KV cache** — a different prompt,
   so a prefix-caching server re-prefills it from nothing.
2. **It is lossy.** Before serializing, Pi truncates *every tool result to
   2,000 characters* (`TOOL_RESULT_MAX_CHARS` in its compaction utils). Measured
   on a 98k-token dropped span, Pi's request was 8,391 tokens — the summary was
   written from roughly 9% of the conversation, with the tool output capped per
   message. For a coding session, the tool output *is* the substance: file
   contents, diffs, test failures, error text.

This extension leaves Pi's trigger and cut alone and replaces only the
summarization call:

1. **Reuse the live prefix.** It asks for the handoff summary as a strict
   continuation of the conversation — the same system prompt, the same tool
   declarations, the same messages — followed by one user turn asking for the
   summary, so a prefix-caching server serves everything but that short ask from
   cache.
2. **Keep the detail, because it is free.** Pi has to truncate tool results
   precisely because its request is cold. A continuation is a cache hit, so the
   prompt costs almost nothing to make large: the summary is written from the
   real messages, at full fidelity, and the only tokens evaluated are the ask.
3. **Let Pi do the rest.** Pi still decides when to compact, still keeps the
   recent tail, and still appends the compaction entry.
4. **Fail safe.** If the summary comes back empty, truncated, or as a tool call,
   the extension returns nothing and Pi's default summary runs instead.

**The shape is the whole trick.** Sending only the span Pi is about to drop
*looks* right — it is a prefix of the live request — but on an append-only cache
(llama.cpp's per-slot checkpoint) a shorter request is a **rewind**, and a rewind
re-prefills from scratch: a request 35 tokens shorter than the checkpoint
re-prefilled all 7710 tokens, while a continuation reused 7706/7745 in 0.4 s. So
the ask is appended to the conversation instead, and the summary's *scope* is
steered by instruction. On a server that caches arbitrary shared prefixes
(vLLM-style) both shapes hit, and `continuation: false` sends the smaller one.

## Install

Requires Pi with the `session_before_compact` extension hook (tested against
`@earendil-works/pi-coding-agent` 0.87.0). No build step — Pi loads the
TypeScript extension directly.

```bash
pi install npm:pi-cache-compact
# or from a checkout, without installing anything
pi -e ./src/extension.ts
```

## Configure

Options are read from JSON, merged with the project file winning:

1. `<agent-dir>/cache-compact.json` (personal; `~/.pi/agent` by default)
2. `<cwd>/.pi/cache-compact.json` (project)

```json
{
  "models": ["local/qwen3-coder"]
}
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Disable the extension entirely. |
| `models` | string[] | `[]` (all) | Only act on these `provider/modelId`s. Scope it to your local endpoint. |
| `summaryModel` | `{ provider, id }` | active model | Summarize with a different (e.g. cheaper) model. |
| `summaryPrompt` | string | [see `src/build.ts`](src/build.ts) | Replace the handoff instruction. |
| `summaryMaxTokens` | number | derived | Cap on the summary's output tokens. By default it is **Pi's own ceiling** (`0.8 × reserveTokens`, clamped to the model's `maxTokens`) bounded by half of what this compaction drops, with a 2048 floor for thinking tokens — so a checkpoint is never larger than what it replaces. Set a number to override all of that. A reply truncated at the cap is rejected and Pi's default runs, so prefer a generous cap. |
| `summaryReasoningEffort` | `"off" \| "none" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"` | mirror the live request | Force an effort. The default mirrors what the last live request actually sent, because the effort reaches the prompt on some servers (see Caveats). `"none"` sends `reasoning_effort: "none"`, which llama.cpp documents as disabling reasoning *without* handing the value to the chat template; `"off"` sends no field at all, leaving the server's default. Either is worth trying if a reasoning model keeps ending its turn inside its reasoning block. |
| `cacheRetention` | `"none" \| "short" \| "long"` | `"short"` | Cache retention for the summary request. |
| `toolChoice` | `"none" \| "auto"` | `"none"` | Forbid tool calls in the summary reply; tools are still declared for the prefix. |
| `deferAfterCacheMiss` | boolean | `true` | After a continuation reads nothing from the cache (the server dropped the conversation), leave the next compaction to Pi's small truncated summary instead of paying a full cold prefill of the whole conversation. Re-arms after 15 minutes. |
| `continuation` | boolean | `true` | Send the ask as a forward continuation of the live conversation (`continuation`, or `continuation-request` when the whole projection no longer fits the window) instead of a rewind to the dropped span. On append-only caches (llama.cpp slots) a rewind re-prefills everything. `false` sends only the dropped span. |
| `rewindWhenNeeded` | boolean | `false` | When no continuation fits the context window, send the rewinding shape (the dropped span alone) instead of leaving that compaction to Pi. Off by default: a rewind never reused a cache in any measurement and costs a whole cold prefill, while Pi's own summary is a small prompt. Enable it on a server that caches arbitrary shared prefixes. |
| `debug` | boolean | `false` | Log decisions to stderr. |
| `debugFile` | string | — | With `debug`, also append structured JSONL records (request fingerprints, request/response headers redacted, summary lifecycle) to this file. |
| `debugPayloads` | boolean | `false` | With `debug` + `debugFile`, dump the full request payloads around a compaction. **Contains the whole conversation** — keep the file private. |

## How it works

Pi computes the context size from the last reported usage and compacts when it
crosses `contextWindow - reserveTokens`. That fires `session_before_compact`,
where an extension can supply its own summary.

The extension appends one user turn — the ask — to the live conversation and
calls `ctx.modelRegistry.complete(...)`; Pi persists the returned summary as a
normal `CompactionEntry` while keeping its own tail.

*Forward* rather than *"a prefix of the live prompt"* is the part that took
measurement to get right. The obvious shape — send only the span Pi is about to
drop, which is a prefix of the live request — is a **rewind**, and an
append-only server cache (llama.cpp's per-slot KV checkpoint) answers a rewind
with a full re-prefill: a request 35 tokens shorter than the checkpoint
re-prefilled all 7710 tokens, while a continuation of it reused 7706/7745 in
0.4 s. Which messages the request carries is therefore chosen per compaction,
largest first, and only among shapes that fit the context window:

- `continuation` — the whole projection. Extends the checkpoint *including* the
  reply the server generated, so it is the safest cache bet.
- `continuation-request` — the messages of the last live request, which is the
  exact prompt sitting in the server's cache. This is the shape that fits when a
  large tool result arrives and pushes the conversation over the compaction
  threshold: Pi compacts because of that output, and including it (plus the
  output budget) no longer fits the window.
- `dropped` — the rewind. Only used when `continuation: false` asks for it, or
  when `rewindWhenNeeded: true` and nothing else fits. Otherwise a compaction
  where only the rewind fits is **left to Pi**: the rewind has never reused a
  cache in any measurement and costs the whole conversation as a cold prefill,
  which is worse than Pi's own small (truncated) prompt. Same rule after a
  measured miss, via `deferAfterCacheMiss`.

Mirroring goes beyond the body: the ask replays the request headers the last
live request sent (minus transport-managed ones and `null` deletions), so
routing- or affinity-relevant headers match too, and it mirrors the reasoning
effort actually on the wire. Session-affinity headers (`x-session-affinity`,
added by pi-ai below the extension hooks when `compat.sendSessionAffinityHeaders`
is on) need no mirroring: both requests share the model and the session id, so
pi-ai derives them identically.

Every estimate in the fit check is **calibrated** against the server's own
reported prompt size (the same messages, so their ratio corrects the bytes-per-
token guess), and the reported part itself is exact. Without that, blob-heavy
transcripts came out ~3x high — enough to refuse a shape that would have fitted
and to make the reclaimed-size ceiling inert.

The summary *text* is still scoped to what compaction drops: Pi keeps
`keepRecentTokens` verbatim, so a summary that also covered the kept tail would
describe those messages twice and `summary + kept tail` could exceed what it
replaced. With the continuation shape that scope comes from a note in the ask
(which names the boundary message), not from truncating the request — that is
the whole trick.

The e2e test proves this from the recorded HTTP bodies: the summary request keeps
the conversation's system prompt, declares the same tools, and the previous live
request is a **strict prefix** of it — the entire live prompt is reusable from
cache, and only the ask is new.

### What the summary contains

The ask is **Pi's own compaction prompt, copied verbatim** from
`core/compaction/compaction.js` (currently v0.87.0) — the structured checkpoint
with `## Goal`, `## Constraints & Preferences`, `## Progress`, `## Key
Decisions`, `## Next Steps`, `## Critical Context`. Pi does not export those
strings, so they are vendored; if Pi changes its format, copy the new text over.
The point is that the persisted summary is the artifact Pi would have written,
whichever path produced it:

- an existing summary switches the prompt to Pi's **update** variant (preserve
  what is there, merge the new);
- a **split turn** (the cut lands mid-turn) is asked for in Pi's two-part shape:
  the history summary, then `---`, then `**Turn Context (split turn):**` and the
  turn-prefix summary. Pi makes two calls for that; we ask for both parts in one
  reply, so the turn-prefix *format* is embedded without his prose — handed
  prose inline, the model copied it into the persisted summary;
- the summary is finished with Pi's machine-computed file appendix
  (`<read-files>` / `<modified-files>`), and the compaction result carries the
  same list in `details` — computed from the session, never by the model.

The two deliberate deviations are exactly the ones that make caching work: the
request reuses the conversation's system prompt and tools (Pi sends its own
summarization system prompt, which can never match), and it carries the real
messages instead of a serialization with tool results truncated to 2,000
characters.

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
- The fit estimates are calibrated against one reported prompt size, which
  assumes the conversation tokenizes uniformly. A blob-heavy tail can still be
  under-estimated; the server then rejects the request and Pi's (much smaller)
  default runs, which is why the calibration is bounded and the reported part of
  every estimate is used verbatim.
- Reasoning models occasionally end a turn *inside* their reasoning block, so the
  reply arrives with no text at all. Two defences: the ask is Pi's own prompt,
  which prescribes an exact section format (the cheapest anchor there is, and it
  costs nothing — the ask is not part of the cached prefix), and an empty reply
  gets one retry that asks for the summary's first heading explicitly. Pi does
  **not** disable thinking for compaction either; it sends the session's level,
  exactly like this extension.
- The summary must reuse the exact system prompt and tool declarations. If
  another extension rewrites the request via `context`/`context_with_system`,
  the reconstructed prefix may no longer match (Pi's default will still be
  correct, just cold).
- The reasoning effort can be part of the *prompt*, not just the sampler: on a
  llama.cpp endpoint three variants (omitted, `low`, `medium`) produced three
  distinct cache keys, which is why the extension mirrors the effort the live
  request sent instead of picking one. That measurement went through a server
  running as a *router* with two model instances, so it may have measured the
  router rather than the template. The records settle it for your endpoint: set
  `summaryReasoningEffort` and read `cacheRead` on the next compaction — about
  the prompt size means the effort is free to change, `0` means it is not.
- Some servers serve a request from cache only when it *continues* the one
  before it, and re-prefill anything else — including a shorter request that is
  a prefix of it. One shared endpoint did exactly that: byte-identical repeats
  read ~96k of ~96k tokens in 0.8 s, while a rewind read 0 of the same 96k
  prefix **11 ms** after a live turn had read it. The extension handles it (the
  ask is a continuation, and a compaction where only a rewind would fit is left
  to Pi), but the `provider_request.rolling` / `provider_headers` /
  `provider_response` records are what tell you which of the two your server is
  doing.

## Debugging cache divergence

If compactions keep missing the prefix cache (`cacheRead: 0` on the summary
request despite the extension working), set:

```json
{ "debug": true, "debugFile": "/tmp/cache-compact-debug.jsonl" }
```

Every outgoing provider request — live turns (`before_provider_request` hook)
and the extension's own summarization call (pi-ai's `onPayload`, since our call
bypasses the extension runner) — is appended as a `provider_request` record
containing no payload content, only hashes:

- `rolling[]` — one entry per message: `rolling[i] = H(rolling[i-1] + H(message[i]))`.
  Equal prefixes of `rolling` ⟺ byte-identical message prefixes. Diff the arrays
  of the summary record against the preceding live record: the first differing
  index is where a prefix-caching server misses. Index 0 differing means the
  system prompt (or tools — see `toolsHash`) diverged.
- `summary: true` marks the extension's own request; `systemSource` says whether
  the system prompt came from the recorded transcript (`recorded`, the
  production path) or was rebuilt (`synthesized`); `requestShape` is
  `continuation` (whole projection), `continuation-request` (the last live
  request's messages — both forward, both cache-friendly) or `dropped` (a
  rewind, which re-prefills on an append-only cache), with
  `droppedCount`/`sentCount` giving what the summary covers versus what the
  request carried.
- `summary_start` / `summary_result` bracket each summarization with usage and
  timing; `summary_result.cacheRead` is the number you are hunting. A rejected
  attempt logs `stopReason`, `usage` and a per-block `blocks` summary
  (`[{type, chars}]`) — that is how a reply that stopped with **no text block**
  (the answer never left the reasoning channel) is told apart from a token-cap
  truncation, a tool call or a transport error.
- A continuation that read nothing from the cache is reported as *"previous
  continuation missed the cache; leaving compaction to Pi"*, and the next
  compaction steps aside (see `deferAfterCacheMiss`) — a cold whole-conversation
  prefill costs far more than Pi's little truncated prompt.
- `summary_retry` records the one retry that empty reply earns: the request is a
  cache hit, so it costs seconds. The retry appends its nudge after the ask, so
  everything the cache covers is unchanged.
- `provider_headers` — the request headers of a live turn (`summary: false`,
  from the `before_provider_headers` hook) and of the ask (`summary: true`,
  including what it replayed and whether a live request was observed at all).
- `provider_response` — response headers of live turns (`summary: false`,
  `after_provider_response`) and of the ask (`summary: true`, pi-ai's
  `onResponse`): replica/routing echoes and cache hints the body does not show.

  Header *values* of secret-looking names (`authorization`, `x-api-key`,
  `cookie`, …) are logged as `[redacted]`; the header *names* stay visible,
  because which headers differ is the diagnostic. If both live records show
  an empty bag, headers are provably not the reason a cache keeps missing.

For the *bytes* rather than the hashes, add `"debugPayloads": true`. The last
live request before a compaction (`live_before`), the summarization request, and
the first live request after it (`live_after`) are then dumped in full — only
around compactions, not per request. Diff the pair with the shipped script:

```bash
node scripts/compare-dumps.mjs /tmp/cache-compact-debug.jsonl
# messages: live_before=14, summarization=9, shared prefix=9
# RESULT: one request is a byte-identical prefix of the other (cache covers the first 9 messages).
```

It reports parameter diffs (usually just `max_tokens`), tool-declaration drift,
and the first differing message with a byte-level context snippet — enough to
tell an intentional cut (kept tail vs the ask) from real drift (same logical
message, different bytes). `debugPayloads` records contain the entire
conversation: never commit or share the dump file.

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
├── config.ts      # pure-ish: option parsing and file loading
└── debug.ts       # pure: rolling hashes, payload fingerprints, JSONL logger
test/
├── build.test.ts       # pure helpers
├── config.test.ts      # option parsing/merging
├── extension.test.ts   # handler with a mock Pi context
└── e2e.test.ts         # real Pi + mock model server
scripts/
└── compare-dumps.mjs   # diff two recorded payloads from debugFile
```

## License

[MIT](LICENSE).
