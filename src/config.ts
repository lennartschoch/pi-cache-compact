/**
 * Configuration for pi-cache-compact.
 *
 * Pi extension factories receive no options object, so options are read from
 * JSON files at call time, merged in order:
 *
 *   1. `<agent-dir>/cache-compact.json`      (personal)
 *   2. `<cwd>/.pi/cache-compact.json`        (project; wins on conflicts)
 *
 * Everything is optional. Missing files and unknown keys are ignored; a
 * malformed file is a hard error the caller reports and then ignores.
 */

import { existsSync, readFileSync } from "node:fs"

export type CacheRetention = "none" | "short" | "long"

export type SummaryReasoningEffort = "off" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

export interface CacheCompactOptions {
  /** Set false to disable the extension entirely. */
  enabled?: boolean
  /**
   * Only replace compaction summaries for these models, as `provider/modelId`.
   * Empty or omitted means every model.
   */
  models?: string[]
  /**
   * Summarize with a different model than the one being compacted, e.g. a
   * cheaper local model. Falls back to the active model when not found.
   */
  summaryModel?: { provider: string; id: string }
  /** Replace the default handoff instruction. */
  summaryPrompt?: string
  /**
   * Cap on the summary's output tokens. Default 8192. Must fit the whole
   * reply: on reasoning models the thinking tokens count against this cap,
   * and a reply truncated at the cap is rejected (Pi's cold default then
   * runs). 2048 was too small for 100k+ sessions on thinking-enabled servers.
   */
  summaryMaxTokens?: number
  /**
   * Force a reasoning effort on the summarization request. `"off"` sends no
   * `reasoning_effort` field at all, which is the closest thing to "do not
   * think about this" a request can say — useful when a reasoning model keeps
   * ending its turn inside the thinking channel and never writes the summary.
   * Check `cacheRead` on the next compaction afterwards: if it stays at the
   * prompt size the change is free, if it drops to 0 the server keys its cache
   * on the rendered effort and the change costs the whole prefix.
   *
   * When omitted, the extension mirrors the effort the session's last live
   * request actually sent — which is almost always what you want, see the caveat below. Only
   * set this to deviate deliberately (e.g. to spend fewer thinking tokens and
   * accept one cold prefill per compaction).
   *
   * CAVEAT (verified against OpenAI-compatible "next"-style servers): the
   * effort changes the *rendered prompt* (effort-dependent template text),
   * so any mismatch against the cached live prefix — including "omitted",
   * a third variant distinct from every explicit level — misses the prefix
   * cache entirely. That is why the value is mirrored from the wire instead
   * of being configured, and why thinking pressure should be answered by
   * raising `summaryMaxTokens`, not by lowering effort.
   */
  summaryReasoningEffort?: SummaryReasoningEffort
  /**
   * Provider cache retention for the summarization request. "short" (default)
   * keeps it eligible for the same prefix cache the conversation uses.
   */
  cacheRetention?: CacheRetention
  /**
   * Whether the summary request advertises tools. "none" (default) asks the
   * provider to forbid tool calls; the tools are still declared so the prompt
   * prefix matches the conversation.
   */
  toolChoice?: "none" | "auto"
  /**
   * Whether the summarization *request* is a strict forward continuation of the
   * live conversation (default true) or only the span compaction drops.
   *
   * Why this matters, verified on a llama.cpp endpoint: the server's cache is
   * append-only. A request that extends the checkpoint the slot already holds is
   * served from cache (7706/7745 tokens in 0.4 s); a request that *rewinds*
   * to a prefix of it — even 35 tokens shorter — is a full re-prefill. The
   * dropped span is always shorter than the live request, so it always rewinds
   * and always re-prefills. Appending the ask to the full message list instead
   * keeps the request forward, and only the ask is evaluated.
   *
   * Automatically falls back to the dropped-span shape when the continuation
   * would not fit the context window (see `continuationFits`), because a
   * request that overflows is rejected outright and Pi's cold default runs.
   */
  continuation?: boolean
  /**
   * Try the rewinding shape (the dropped span alone) when no continuation fits
   * the context window, instead of leaving that compaction to Pi. Default
   * false: a rewind never reused a cache in any measurement and costs a whole
   * cold prefill, while Pi's own summary is a small prompt. Only enable this on
   * a server that caches arbitrary shared prefixes.
   */
  rewindWhenNeeded?: boolean
  /**
   * Let Pi's own (small, truncated) summary take the next compaction after a
   * continuation missed the cache. Default true.
   *
   * Reusing the conversation's cache is nearly free, but only while the server
   * still holds it. When it does not, the continuation is a *large* cold
   * prefill (the whole conversation, minutes on a shared box) while Pi's default
   * is a small one built from a truncated transcript (seconds). The extension
   * knows which happened — its own summary response reports how much it read
   * from cache — so after a miss it steps aside for a while rather than paying
   * the full prefill again. Set false to always try the continuation.
   */
  deferAfterCacheMiss?: boolean
  /** Verbose logging to stderr. Default false. */
  debug?: boolean
  /**
   * JSONL file that structured debug records are appended to (requires
   * `debug: true`). Needed because stderr is not persisted under daemon hosts
   * (Paseo, IDE wrappers). Records: `provider_request` message-hash
   * fingerprints for every outgoing request (live turns and summarization
   * alike), plus `summary_start` / `summary_result` / `summary_retry` and the
   * rejection diagnostics (stopReason, usage, block sizes).
   * Compare two `provider_request` records' `rolling` arrays: the first
   * differing index is where the prefix cache diverges. Use an absolute path.
   */
  debugFile?: string
  /**
   * With `debug` + `debugFile`: additionally dump the *full request payloads*
   * around a compaction — the last live request before it (`variant:
   * "live_before"`), our summary request (`variant: "summarization"`), and the
   * first live request after it (`variant: "live_after"`) — as `payload_dump`
   * records. Fingerprints tell you *where* two requests diverge; dumps tell
   * you *what* differs. These records contain the whole conversation, so the
   * option is opt-in and the file must not be committed or shared. Use
   * `scripts/compare-dumps.mjs` to diff a pair. Only the last live request is
   * retained in memory between requests; nothing is written unless a
   * compaction actually happens.
   */
  debugPayloads?: boolean
}

// 8192, not 2048: the cap must cover thinking tokens *plus* a complete handoff
// summary of the dropped span. A reply that hits the cap is rejected and Pi
// falls back to its cold default summary — losing the entire cache benefit —
// so a generous cap is strictly cheaper than a tight one.
export const DEFAULT_SUMMARY_MAX_TOKENS = 8192

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((item): item is string => typeof item === "string")
  return strings.length > 0 ? strings : undefined
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  const rounded = Math.floor(value)
  return rounded > 0 ? rounded : undefined
}

function summaryModel(value: unknown): { provider: string; id: string } | undefined {
  if (!isRecord(value)) return undefined
  const { provider, id } = value
  if (typeof provider !== "string" || typeof id !== "string") return undefined
  if (!provider || !id) return undefined
  return { provider, id }
}

function cacheRetention(value: unknown): CacheRetention | undefined {
  return value === "none" || value === "short" || value === "long" ? value : undefined
}

function toolChoice(value: unknown): "none" | "auto" | undefined {
  return value === "none" || value === "auto" ? value : undefined
}

function reasoningEffort(value: unknown): SummaryReasoningEffort | undefined {
  return value === "off" || value === "none" || value === "minimal" || value === "low" ||
    value === "medium" || value === "high" || value === "xhigh" || value === "max"
    ? value
    : undefined
}

/** Parse one options object. Unknown and wrongly typed fields are dropped. */
export function parseOptions(raw: unknown): CacheCompactOptions {
  if (!isRecord(raw)) return {}
  const options: CacheCompactOptions = {}
  if (typeof raw.enabled === "boolean") options.enabled = raw.enabled
  const models = stringArray(raw.models)
  if (models) options.models = models
  const model = summaryModel(raw.summaryModel)
  if (model) options.summaryModel = model
  if (typeof raw.summaryPrompt === "string" && raw.summaryPrompt.trim()) {
    options.summaryPrompt = raw.summaryPrompt
  }
  const maxTokens = positiveInt(raw.summaryMaxTokens)
  if (maxTokens) options.summaryMaxTokens = maxTokens
  const effort = reasoningEffort(raw.summaryReasoningEffort)
  if (effort) options.summaryReasoningEffort = effort
  const retention = cacheRetention(raw.cacheRetention)
  if (retention) options.cacheRetention = retention
  const choice = toolChoice(raw.toolChoice)
  if (choice) options.toolChoice = choice
  if (typeof raw.continuation === "boolean") options.continuation = raw.continuation
  if (typeof raw.deferAfterCacheMiss === "boolean") options.deferAfterCacheMiss = raw.deferAfterCacheMiss
  if (typeof raw.rewindWhenNeeded === "boolean") options.rewindWhenNeeded = raw.rewindWhenNeeded
  if (typeof raw.debug === "boolean") options.debug = raw.debug
  if (typeof raw.debugFile === "string" && raw.debugFile.trim()) {
    options.debugFile = raw.debugFile.trim()
  }
  if (typeof raw.debugPayloads === "boolean") options.debugPayloads = raw.debugPayloads
  return options
}

/**
 * Merge option files in order (later wins). Missing files are skipped.
 * `parseOptions` only returns keys the file actually set, so a sparse project
 * file cannot undo `enabled: false` (or `debugFile`) from the personal file.
 */
export function readOptions(paths: readonly string[]): CacheCompactOptions {
  const merged: CacheCompactOptions = {}
  for (const path of paths) {
    if (!existsSync(path)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"))
    } catch (error) {
      throw new Error(`cache-compact: ${path} is not valid JSON: ${String(error)}`)
    }
    Object.assign(merged, parseOptions(parsed))
  }
  return merged
}
