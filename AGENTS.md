# AGENTS.md

Guidance for agents working in this repo. Read [`README.md`](README.md) first for
what the extension is and how it is installed.

## Hard rules

**Never run `git commit` or `git push`** unless explicitly asked in that message.
Write files, stage nothing, report what changed, and let the human commit.

**Conventional Commits**, title line only, imperative, lower case, no trailing
period: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `build:`,
`ci:`, `perf:`.

**Semantic Versioning.** Bump `version` in `package.json` in the same commit:
`feat` → minor, `fix` → patch, breaking → major. `docs`/`test`/`chore` do not
need a bump unless they change published behaviour.

**No secrets, ever** — nothing here needs one.

## What this is

A Pi extension that replaces Pi's compaction *summary generation* with a
cache-friendly one:

> threshold crossed → Pi fires `session_before_compact` → we send the
> summarization ask as a continuation of the live conversation (same system
> prompt, same tools, same messages) → Pi persists the returned summary and
> keeps its own cut/trigger.

It exists because Pi's default summary is a cold, re-serialized prompt that a
prefix-caching local server must re-read in full. See README → "Why".

## Invariants — do not break these

| Thing | Why |
|---|---|
| `src/extension.ts` default-exports the factory and nothing else at runtime | Pi calls the default export; extra runtime exports are noise. Type-only exports are fine. |
| The summary request must reuse the conversation's exact prefix | Same system prompt, same tools, same messages, then the ask. Anything else and the cache misses — the whole point is lost. |
| Summarize only the messages before `firstKeptEntryId` | Pi keeps `keepRecentTokens` verbatim. A whole-context summary plus that tail can exceed what it replaced, so the context grows on every compaction. The dropped span is still a prefix of the live prompt, so it is still a cache hit. |
| Do not pass `systemPrompt`/`tools` when the projection already has a leading system message | The provider would replay/concatenate the prompt twice and the prefix would break. See `hasLeadingSystemMessage` in `extension.ts`. |
| Return `undefined` (not a partial summary) when the reply is empty, truncated, aborted, or a tool call | A bad summary must never become the new conversation prefix. Pi's default then runs. |
| Never throw out of the handler | Pi catches, but we want the default fallback, not an error surfaced to the user. |
| `src/build.ts` stays pure (type-only SDK imports) | Unit tests exercise it without booting Pi. |

## Layout

```
src/extension.ts   # default export; session_before_compact handler
src/build.ts       # pure helpers: prompt, tool declarations, request assembly
src/config.ts      # option parsing + merging JSON files
test/              # build, config, extension (mock ctx), e2e (real Pi + mock model)
```

## Commands

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # unit tests (node --test)
npm run test:e2e    # real `pi --print` + mock model server (opt-in)
```

Node 24+ — the repo runs TypeScript directly and uses `node --test`.

## Verifying

- **Unit** (`npm test`) covers the pure assembly, option parsing, and the
  handler's fallbacks with a mock context. Any change to the request shape, the
  fallback rules, or the options needs a matching test.
- **End-to-end** (`npm run test:e2e`) is the one that catches real Pi behaviour:
  it spawns `pi --print` with the extension loaded from source and a mock
  OpenAI-compatible server that records HTTP bodies, then asserts the summary
  request keeps the system prompt and tools, starts with the previous request's
  exact prefix, and is the summary Pi persists. Run it after touching the
  entry point, the hook, or the request assembly. It caught the doubled system
  prompt bug.

## Conventions

- Prefer explaining *why* in comments — especially the prefix-reuse invariant.
- Keep the README caveats honest: if a workaround is removed, explain the cost
  in the same change.
- Config lives in `cache-compact.json` under the agent dir and `<cwd>/.pi`;
  document any new option in the README table.
