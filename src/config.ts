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
  /** Cap on the summary's output tokens. Default 2048. */
  summaryMaxTokens?: number
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
  /** Verbose logging to stderr. Default false. */
  debug?: boolean
}

export const DEFAULT_SUMMARY_MAX_TOKENS = 2048

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
  const retention = cacheRetention(raw.cacheRetention)
  if (retention) options.cacheRetention = retention
  const choice = toolChoice(raw.toolChoice)
  if (choice) options.toolChoice = choice
  if (typeof raw.debug === "boolean") options.debug = raw.debug
  return options
}

/** Merge option files in order (later wins). Missing files are skipped. */
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
