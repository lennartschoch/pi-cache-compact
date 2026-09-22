/**
 * pi-cache-compact — cache-friendly compaction for Pi.
 *
 * Pi's default compaction builds a brand-new request to write the summary: its
 * own system prompt, the transcript re-serialized into one user message, and
 * cache writes disabled. On a locally hosted model with prefix caching that can
 * never reuse the KV cache, so the whole conversation is re-prefilled just to
 * produce the summary — the expensive part you were trying to avoid.
 *
 * This extension leaves Pi's trigger and cut alone and replaces only the
 * summarization call. It asks for the summary as a strict continuation of the
 * live conversation (same system prompt, same tools, same messages, one
 * appended user turn), so a prefix-caching server serves everything but the ask
 * from cache and only generates the summary.
 *
 * It hooks `session_before_compact`, so Pi still decides when to compact, keeps
 * the recent tail, and appends the compaction entry. If the summary is empty,
 * truncated, or errors, the handler returns nothing and Pi's default summary
 * runs instead.
 */

import { join } from "node:path"

import { CONFIG_DIR_NAME, convertToLlm, getAgentDir } from "@earendil-works/pi-coding-agent"
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai"

import {
  activeToolDeclarations,
  buildSummaryContext,
  extractSummaryText,
  isModelAllowed,
  messagesBeforeEntry,
  renderSummaryAsk,
  summaryRejection,
} from "./build.ts"
import {
  DEFAULT_SUMMARY_MAX_TOKENS,
  readOptions,
  type CacheCompactOptions,
} from "./config.ts"

export type { CacheCompactOptions } from "./config.ts"

function log(options: CacheCompactOptions, message: string, extra: Record<string, unknown> = {}): void {
  if (!options.debug) return
  try {
    process.stderr.write(`[cache-compact] ${message} ${JSON.stringify(extra)}\n`)
  } catch {
    /* never throw from logging */
  }
}

/** Summarize with `summaryModel` when configured and resolvable, else the active model. */
function resolveSummarizer(
  ctx: ExtensionContext,
  options: CacheCompactOptions,
  fallback: Model<Api>,
): Model<Api> {
  const wanted = options.summaryModel
  if (!wanted) return fallback
  return ctx.modelRegistry.find(wanted.provider, wanted.id) ?? fallback
}

/** Build and run the cache-friendly summarization request. */
async function generateSummary(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event: SessionBeforeCompactEvent,
  options: CacheCompactOptions,
  summarizer: Model<Api>,
): Promise<AssistantMessage> {
  const projection = ctx.sessionManager.buildSessionProjection()
  // Summarize only what compaction drops (everything before the kept tail). That
  // span is a prefix of the live request, so it is still a cache hit — while a
  // whole-context summary would fight Pi's retained tail and grow the context.
  const dropped = messagesBeforeEntry(projection.entries, event.preparation.firstKeptEntryId)
  const agentMessages = (dropped ?? [
    ...event.preparation.messagesToSummarize,
    ...event.preparation.turnPrefixMessages,
  ]) as AgentMessage[]

  const messages = convertToLlm(agentMessages)
  // The projection usually starts with the recorded system message (prompt and
  // tool declarations). Recreating it would declare the prompt twice and break
  // the prefix; only synthesize one when the transcript has none.
  const hasLeadingSystemMessage = messages[0]?.role === "system"
  const context = buildSummaryContext({
    systemPrompt: hasLeadingSystemMessage ? undefined : ctx.getSystemPrompt(),
    tools: hasLeadingSystemMessage ? undefined : activeToolDeclarations(pi.getAllTools(), pi.getActiveTools()),
    messages,
    ask: renderSummaryAsk(options, event.customInstructions),
  })
  return ctx.modelRegistry.complete(summarizer, context, {
    maxTokens: options.summaryMaxTokens ?? DEFAULT_SUMMARY_MAX_TOKENS,
    signal: event.signal,
    cacheRetention: options.cacheRetention ?? "short",
    toolChoice: options.toolChoice ?? "none",
    sessionId: ctx.sessionManager.getSessionId(),
  })
}

export default function cacheCompact(pi: ExtensionAPI): void {
  // Options are per working directory and read lazily, so a session started
  // after a config edit picks up the new file without a reload.
  const configs = new Map<string, CacheCompactOptions>()

  const optionsFor = (ctx: ExtensionContext): CacheCompactOptions => {
    const cached = configs.get(ctx.cwd)
    if (cached) return cached
    const paths = [
      join(getAgentDir(), "cache-compact.json"),
      join(ctx.cwd, CONFIG_DIR_NAME, "cache-compact.json"),
    ]
    let options: CacheCompactOptions = {}
    try {
      options = readOptions(paths)
    } catch (error) {
      process.stderr.write(`[cache-compact] ignoring config: ${String(error)}\n`)
    }
    configs.set(ctx.cwd, options)
    return options
  }

  pi.on("session_before_compact", async (event, ctx): Promise<SessionBeforeCompactResult | undefined> => {
    const options = optionsFor(ctx)
    if (options.enabled === false) return

    const model = ctx.model
    if (!model) return
    if (!isModelAllowed(options.models, model.provider, model.id)) return

    const summarizer = resolveSummarizer(ctx, options, model)
    const sessionId = ctx.sessionManager.getSessionId()

    try {
      const response = await generateSummary(pi, ctx, event, options, summarizer)
      const rejection = summaryRejection(response)
      if (rejection) {
        log(options, "summary rejected; leaving compaction to Pi", { sessionId, reason: rejection })
        return
      }
      const summary = extractSummaryText(response.content)
      log(options, "wrote cache-friendly summary", {
        sessionId,
        chars: summary.length,
        cacheRead: response.usage.cacheRead,
        cacheWrite: response.usage.cacheWrite,
        summarizer: `${summarizer.provider}/${summarizer.id}`,
      })
      return {
        compaction: {
          summary,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          usage: response.usage,
        },
      }
    } catch (error) {
      log(options, "summary request failed; leaving compaction to Pi", {
        sessionId,
        error: String(error),
      })
      return
    }
  })
}
