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
  computeFileLists,
  formatFileOperations,
  extractLiveReasoningEffort,
  extractSummaryText,
  isModelAllowed,
  messagesBeforeEntry,
  planSummaryRequest,
  replayableHeaders,
  resolveSummaryReasoningEffort,
  summaryRejection,
  summaryOutputCap,
  looksLikeToolCall,
  NO_TEXT_REPLY,
  TOOL_CALL_TEXT_REPLY,
  type LiveEffort,
  type SummaryRequestPlan,
  type SummaryRequestShape,
} from "./build.ts"
import {
  DEFAULT_SUMMARY_MAX_TOKENS,
  readOptions,
  type CacheCompactOptions,
} from "./config.ts"
import { DebugLogger, fingerprintPayload, redactHeaders, shortHash, snapshot } from "./debug.ts"

export type { CacheCompactOptions } from "./config.ts"

function loggerFor(options: CacheCompactOptions): DebugLogger {
  return new DebugLogger(options.debug === true, options.debugFile)
}

/**
 * A prompt below this many tokens is cheap enough to re-prefill cold that a
 * cache miss tells us nothing worth acting on.
 */
const CACHE_MISS_MIN_PROMPT_TOKENS = 4096

/**
 * How long a cache miss suppresses the continuation. Long enough to cover the
 * busy spell that caused it, short enough that a session running long enough for
 * another compaction gets a fresh attempt.
 */
const DEFER_AFTER_MISS_MS = 15 * 60 * 1000

/**
 * Compact description of an assistant reply's blocks, for the debug file. A
 * reply that "stopped" with no text block is the failure this exists to
 * explain: it means the answer never left the reasoning channel, so the counts
 * and sizes per block are the whole diagnosis.
 */
function describeContent(
  content: AssistantMessage["content"],
  preview = false,
): { type: string; chars: number; head?: string }[] {
  return content.map((block) => {
    if (block.type === "text") {
      return { type: "text", chars: block.text.length, ...(preview ? { head: head(block.text) } : undefined) }
    }
    if (block.type === "thinking") {
      const thinking = String(block.thinking ?? "")
      return { type: "thinking", chars: thinking.length, ...(preview ? { head: head(thinking) } : undefined) }
    }
    return { type: block.type, chars: 0 }
  })
}

/** First `limit` characters, for telling a finished summary from deliberations. */
function head(text: string, limit = 160): string {
  const collapsed = text.replace(/\s+/g, " ").trim()
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed
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
  reasoningEffort: string | undefined,
  plan: SummaryRequestPlan,
  onPayload?: (
    payload: unknown,
    info: {
      hasLeadingSystemMessage: boolean
      droppedCount: number
      sentCount: number
      requestShape: SummaryRequestShape
    },
  ) => void,
  requestHeaders?: Record<string, string | null>,
): Promise<AssistantMessage> {
  const messages = plan.messages
  const ask = plan.ask
  // The projection usually starts with the recorded system message (prompt and
  // tool declarations). Recreating it would declare the prompt twice and break
  // the prefix; only synthesize one when the transcript has none.
  // Which branch runs is logged: the two must produce byte-identical requests
  // against the live prefix, and only the synthesized branch is covered by
  // e2e tests — a recorded-system divergence would miss the cache entirely.
  const hasLeadingSystemMessage = messages[0]?.role === "system"
  const context = buildSummaryContext({
    systemPrompt: hasLeadingSystemMessage ? undefined : ctx.getSystemPrompt(),
    tools: hasLeadingSystemMessage ? undefined : activeToolDeclarations(pi.getAllTools(), pi.getActiveTools()),
    messages,
    ask,
  })
  return await ctx.modelRegistry.complete(summarizer, context, {
    maxTokens: plan.maxTokens,
    signal: event.signal,
    cacheRetention: options.cacheRetention ?? "short",
    toolChoice: options.toolChoice ?? "none",
    // Mirror the effort the live prefix was actually sent with (see
    // extractLiveReasoningEffort): on servers that render the effort into the
    // prompt, any mismatch — including plain omission — misses the whole
    // prefix cache. Undefined reproduces the live omission.
    ...(reasoningEffort !== undefined ? { reasoningEffort } : undefined),
    // Replay the headers live requests send (session affinity, routing keys,
    // attribution) so the summarization ask is indistinguishable from a live
    // turn at the transport layer too. Live evidence: our ask was byte-
    // identical to a live request whose prefix hit the cache seconds before,
    // yet read 0 — the divergence, if it is in the request, can only live in
    // headers the payload dump cannot see.
    ...(requestHeaders !== undefined ? { headers: requestHeaders } : undefined),
    sessionId: ctx.sessionManager.getSessionId(),
    // Our own complete() call bypasses the extension runner, so
    // before_provider_request never sees it. pi-ai invokes onPayload with the
    // exact request params at the same point the hook fires for live requests,
    // which lets the debug file fingerprint both at the same level. Must not
    // return anything: a returned value would replace the outgoing payload.
    onPayload: onPayload
      ? (payload: unknown) => {
          onPayload(payload, {
            hasLeadingSystemMessage,
            droppedCount: plan.droppedMessages.length,
            sentCount: plan.messages.length,
            requestShape: plan.shape,
          })
        }
      : undefined,
    // Response headers of the summarization request (which replica answered,
    // cache echoes, via/chains) — the counterpart of the live
    // `after_provider_response` records, logged so the two can be diffed.
    onResponse: (response: { status: number; headers: Record<string, string> }) => {
      try {
        loggerFor(options).record("provider_response", {
          sessionId: ctx.sessionManager.getSessionId(),
          summary: true,
          status: response.status,
          headers: redactHeaders(response.headers),
        })
      } catch {
        /* logging must never break the request path */
      }
    },
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

  // Ask-text hashes of summarization requests currently in flight. A
  // payload whose last user message hashes to one of these is one of ours;
  // belt and braces alongside the direct onPayload tagging below, in case a
  // future pi routes extension calls through the runner after all.
  const pendingAskHashes = new Set<string>()

  // Last live payloads, JSON-snapshotted, kept for `debugPayloads` dumps.
  // Snapshotted at capture (not at write) because the request object may be
  // mutated after the hook fires; capped at two so a long debug session does
  // not pin megabytes. Written out only when a compaction actually happens.
  const recentLivePayloads: { sessionId: string; payload: unknown }[] = []
  // Sessions whose next live request should be dumped as `live_after`.
  const dumpNextLive = new Set<string>()

  // Last live request headers, per session, as captured by
  // `before_provider_headers`. The summary ask replays them (see
  // replayableHeaders) and both sides are logged redacted, so the debug file
  // can finally diff what the payload dump never shows: the headers live
  // requests carry and ours does not. Captured regardless of debug settings
  // — replay must work with logging off.
  const liveHeaders = new Map<string, Record<string, string | null>>()

  // Last reasoning effort observed on the wire, per session; `null` = the
  // live request sent none (also a distinct cache variant). The summary ask
  // mirrors this so its prefix matches what the server cached. Captured on
  // every request, independent of debug settings.
  const liveEfforts = new Map<string, LiveEffort>()

  // How many messages the last live provider request carried, per session.
  // Messages appended since (the reply, tool results) are *not* in the
  // checkpoint the server holds, and a big tool result can be most of the
  // context — so this is what lets the ask continue the request itself instead
  // of the (possibly oversized) whole conversation. A count, never content.
  const liveRequestCounts = new Map<string, number>()

  // Whether the last summarization for a session read anything from the cache.
  // A continuation that misses means the server no longer holds the
  // conversation, and then the whole-context request is the *expensive* option
  // — far more so than Pi's little truncated prompt. See `deferAfterCacheMiss`.
  const lastSummaryOutcome = new Map<string, { at: number; missed: boolean }>()

  // Fingerprint every outgoing provider request — live turns and our own
  // summarization call alike. This is what makes cache divergence debuggable
  // after the fact: diff the `rolling` arrays of two records in the debug
  // file and the first differing index is the first message whose bytes
  // differ, i.e. where the prefix cache misses.
  pi.on("before_provider_request", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId()
    try {
      const observed = extractLiveReasoningEffort(event.payload)
      if (observed !== undefined) liveEfforts.set(sessionId, observed)
    } catch {
      /* observation must never break the request path */
    }
    try {
      const messages = (event.payload as { messages?: unknown } | undefined)?.messages
      if (Array.isArray(messages)) liveRequestCounts.set(sessionId, messages.length)
    } catch {
      /* observation must never break the request path */
    }
    try {
      const options = optionsFor(ctx)
      if (options.debug !== true || !options.debugFile) return undefined
      const fingerprint = fingerprintPayload(event.payload)
      const askHash = fingerprint.lastMessageTextHash
      fingerprint.summary =
        typeof askHash === "string" && pendingAskHashes.has(askHash) ? true : undefined
      fingerprint.pendingSummary = pendingAskHashes.size > 0
      loggerFor(options).record("provider_request", {
        sessionId,
        activeModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        ...fingerprint,
      })
      if (options.debugPayloads === true && fingerprint.summary !== true) {
        // Keep the request that is about to hit the wire as `live_before`,
        // and check whether this is the first request after a compaction.
        if (dumpNextLive.delete(sessionId)) {
          loggerFor(options).record("payload_dump", { sessionId, variant: "live_after", payload: snapshot(event.payload) })
        }
        recentLivePayloads.push({ sessionId, payload: snapshot(event.payload) })
        if (recentLivePayloads.length > 2) recentLivePayloads.shift()
      }
    } catch {
      /* logging must never break the request path */
    }
    return undefined
  })

  // Capture (and log, redacted) the exact headers pi assembles for live
  // provider requests. Handlers receive the final bag and may mutate it in
  // place; the return value is ignored, so we only read. pi deletes headers
  // whose value is null, hence the loose value type on capture.
  pi.on("before_provider_headers", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId()
    try {
      liveHeaders.set(sessionId, { ...event.headers })
    } catch {
      /* capture must never break the request path */
    }
    try {
      const options = optionsFor(ctx)
      if (options.debug !== true || !options.debugFile) return
      loggerFor(options).record("provider_headers", {
        sessionId,
        summary: false,
        headers: redactHeaders(event.headers),
      })
    } catch {
      /* logging must never break the request path */
    }
  })

  // Response headers of live requests — replica/routing echoes to diff
  // against the summarization request's `provider_response` record.
  pi.on("after_provider_response", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId()
    try {
      const options = optionsFor(ctx)
      if (options.debug !== true || !options.debugFile) return
      loggerFor(options).record("provider_response", {
        sessionId,
        summary: false,
        status: event.status,
        headers: redactHeaders(event.headers),
      })
    } catch {
      /* logging must never break the request path */
    }
  })

  pi.on("session_before_compact", async (event, ctx): Promise<SessionBeforeCompactResult | undefined> => {
    const options = optionsFor(ctx)
    const log = loggerFor(options)
    // Pi compacts whether or not we win the hook, so the next live request is
    // the "after" side of the payload dump on every path.
    const sessionId = ctx.sessionManager.getSessionId()
    if (options.debug === true && options.debugFile && options.debugPayloads === true) {
      dumpNextLive.add(sessionId)
    }
    if (options.enabled === false) return

    const model = ctx.model
    if (!model) return
    if (!isModelAllowed(options.models, model.provider, model.id)) return

    const summarizer = resolveSummarizer(ctx, options, model)

    // A previous continuation that read nothing from cache means the checkpoint
    // is gone, and paying a full cold prefill of the whole conversation is worse
    // than Pi's small truncated prompt. Step aside for a while.
    const prior = lastSummaryOutcome.get(sessionId)
    if (
      options.deferAfterCacheMiss !== false &&
      prior?.missed === true &&
      Date.now() - prior.at < DEFER_AFTER_MISS_MS
    ) {
      log.both("previous continuation missed the cache; leaving compaction to Pi", {
        sessionId,
        missedAt: new Date(prior.at).toISOString(),
        tokensBefore: event.preparation.tokensBefore,
      })
      return
    }

    // Plan the request once, here, so the `before_provider_request` fallback
    // hash matches the ask that is actually sent (the ask grows a boundary note
    // when the request carries the kept tail).
    const projection = ctx.sessionManager.buildSessionProjection()
    const droppedAgent = (messagesBeforeEntry(projection.entries, event.preparation.firstKeptEntryId) ?? [
      ...event.preparation.messagesToSummarize,
      ...event.preparation.turnPrefixMessages,
    ]) as AgentMessage[]
    // The live request's messages are a prefix of the projection (Pi only
    // appends between requests), so slicing to the observed count reconstructs
    // the exact prompt the server has cached. Falls back to the whole
    // projection when no request has been observed yet, or after a compaction
    // shortened the projection under the recorded count.
    const liveMessages = convertToLlm(projection.messages as AgentMessage[])
    const observedCount = liveRequestCounts.get(sessionId)
    const requestMessages =
      observedCount !== undefined && observedCount > 0 && observedCount < liveMessages.length
        ? liveMessages.slice(0, observedCount)
        : liveMessages
    const plan = planSummaryRequest({
      liveMessages,
      requestMessages,
      droppedMessages: convertToLlm(droppedAgent),
      keptCount: projection.messages.length - droppedAgent.length,
      // Pi splits a turn when the cut lands mid-turn: the retained suffix is the
      // rest of that turn, and its summary goes under a marker heading.
      turnPrefixCount: event.preparation.turnPrefixMessages?.length ?? 0,
      ...(event.preparation.previousSummary
        ? { previousSummary: event.preparation.previousSummary }
        : undefined),
      options,
      customInstructions: event.customInstructions,
      contextWindow: (summarizer as { contextWindow?: number }).contextWindow,
      // Pi's ceiling, bounded by what this compaction reclaims and clamped to
      // the model; `summaryMaxTokens` overrides all of it.
      reserveTokens: event.preparation.settings?.reserveTokens,
      modelMaxTokens: (summarizer as { maxTokens?: number }).maxTokens,
      summaryMaxTokens: options.summaryMaxTokens,
    })
    // The rewind is the one shape that has never reused a cache, and it costs
    // the whole conversation as a cold prefill — more than Pi's own small
    // summary, which is why it is now a deliberate opt-in.
    if (plan.rewindFallback && options.rewindWhenNeeded !== true) {
      log.both("only the rewinding shape fits; leaving compaction to Pi", {
        sessionId,
        tokensBefore: event.preparation.tokensBefore,
      })
      return
    }
    const askHash = shortHash(plan.ask)

    // Effort for the summary ask: explicit config, else whatever the last
    // live request of this session actually sent — the cached prefix is keyed
    // by the sent value, so a mid-session /thinking change makes the live
    // request itself re-prefill, but our ask still matches the newest prefix.
    const reasoningEffort = resolveSummaryReasoningEffort(
      options.summaryReasoningEffort,
      liveEfforts.get(sessionId),
    )

    // Remember whether this request actually reused the cache. A continuation
    // that read nothing means the server dropped the conversation, and then the
    // next compaction is better left to Pi's small prompt (see
    // `deferAfterCacheMiss`). Undefined usage counts as "not missed" so a
    // provider that reports nothing cannot silently disable the extension.
    const recordCacheOutcome = (usage: AssistantMessage["usage"] | undefined): void => {
      try {
        const cacheRead = usage?.cacheRead ?? 0
        const promptTokens = (usage?.input ?? 0) + cacheRead + (usage?.cacheWrite ?? 0)
        lastSummaryOutcome.set(sessionId, {
          at: Date.now(),
          missed: cacheRead === 0 && promptTokens >= CACHE_MISS_MIN_PROMPT_TOKENS,
        })
      } catch {
        /* observation must never break the request path */
      }
    }

    // Fingerprint our summarization request at the exact payload pi-ai sends,
    // tagged so the debug file can be diffed against the live-request
    // fingerprints from before_provider_request.
    const recordSummaryPayload = (
      payload: unknown,
      info: {
        hasLeadingSystemMessage: boolean
        droppedCount: number
        sentCount: number
        requestShape: SummaryRequestShape
      },
    ): void => {
      if (options.debug !== true || !options.debugFile) return
      try {
        const fingerprint = fingerprintPayload(payload)
        fingerprint.summary = true
        // Which code path produced the system prompt: "recorded" reuses the
        // transcript's system message, "synthesized" rebuilds it from
        // getSystemPrompt() + live tool declarations. Divergence between the
        // branches and the live prefix looks different, so record it.
        fingerprint.systemSource = info.hasLeadingSystemMessage ? "recorded" : "synthesized"
        // Request shape: "continuation" sends the whole live message list (the
        // append-only cache's forward extension) and "dropped" only the span
        // compaction discards (a rewind, so a guaranteed cold prefill on such a
        // server). `droppedCount` is what the summary should cover; `sentCount`
        // is what the request actually carried.
        fingerprint.requestShape = info.requestShape
        fingerprint.droppedCount = info.droppedCount
        fingerprint.sentCount = info.sentCount
        log.record("provider_request", {
          sessionId,
          activeModel: `${model.provider}/${model.id}`,
          ...fingerprint,
        })
        if (options.debugPayloads === true) {
          // The comparison pair: the last live request before compaction and
          // our summarization request, byte for byte. `scripts/compare-dumps.mjs`
          // diffs them and prints the first differing message.
          const lastLive = [...recentLivePayloads].reverse().find((entry) => entry.sessionId === sessionId)
          if (lastLive) {
            log.record("payload_dump", { sessionId, variant: "live_before", payload: lastLive.payload })
          }
          log.record("payload_dump", {
            sessionId,
            variant: "summarization",
            systemSource: info.hasLeadingSystemMessage ? "recorded" : "synthesized",
            requestShape: info.requestShape,
            payload: snapshot(payload),
          })
        }
      } catch {
        /* never break the request path over logging */
      }
    }

    // Mirror the live request headers onto the ask (transport-level twin,
    // see replayableHeaders) and log what we will send, redacted.
    let requestHeaders: Record<string, string | null> | undefined
    try {
      requestHeaders = replayableHeaders(liveHeaders.get(sessionId))
    } catch {
      requestHeaders = undefined
    }
    if (options.debug === true && options.debugFile) {
      log.record("provider_headers", {
        sessionId,
        summary: true,
        liveCaptured: liveHeaders.has(sessionId),
        headers: redactHeaders(requestHeaders),
      })
    }

    try {
      log.record("summary_start", {
        sessionId,
        summarizer: `${summarizer.provider}/${summarizer.id}`,
        askHash,
        maxTokens: plan.maxTokens,
        cacheRetention: options.cacheRetention ?? "short",
        toolChoice: options.toolChoice ?? "none",
        reasoningEffort,
        // The shape the request actually uses; `continuation` is the configured
        // option, which is ignored when the continuation would not fit.
        requestShape: plan.shape,
        // Pi's artifact shape: a split turn adds the "Turn Context (split turn)"
        // section, and a previous summary switches the prompt to Pi's update
        // variant.
        splitTurn: plan.split !== undefined,
        previousSummary: Boolean(event.preparation.previousSummary),
        continuationOption: options.continuation !== false,
        sentCount: plan.messages.length,
        droppedCount: plan.droppedMessages.length,
        tokensBefore: event.preparation.tokensBefore,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
      })
      pendingAskHashes.add(askHash)
      const startedAt = Date.now()
      let response: AssistantMessage
      try {
        response = await generateSummary(pi, ctx, event, options, summarizer, reasoningEffort, plan, recordSummaryPayload, requestHeaders)
      } finally {
        // The ask is deterministic, so its hash is known up front; the
        // returned `ask` is only used for that hash, which we already have.
        pendingAskHashes.delete(askHash)
      }
      const durationMs = Date.now() - startedAt
      let rejection = summaryRejection(response)
      // A reply that stopped cleanly with no text at all is the one rejection
      // worth retrying: the model spent its turn in the reasoning channel and
      // never wrote the answer, and since the request is a cache hit the retry
      // costs seconds. The nudge goes at the *end* of the ask, so the cached
      // prefix is untouched.
      // Retry only when it is cheap: a retry on a *miss* would pay a second full
      // cold prefill, which for a large conversation is minutes (and, at that
      // point, worse than Pi's small truncated prompt doing the job).
      const retryAffordable =
        response.usage.cacheRead > 0 ||
        response.usage.input + response.usage.cacheRead < CACHE_MISS_MIN_PROMPT_TOKENS
      if ((rejection === NO_TEXT_REPLY || rejection === TOOL_CALL_TEXT_REPLY) && retryAffordable) {
        log.both("summary reply was unusable; retrying once", {
          reason: rejection,
          sessionId,
          stopReason: response.stopReason,
          usage: response.usage,
          blocks: describeContent(response.content, options.debugPayloads === true),
        })
        const retryPlan: SummaryRequestPlan = {
          ...plan,
          // The retry keeps the cached prefix (the nudge goes after the ask) and
          // is concrete on purpose: a reply that stops inside the reasoning
          // channel is best discouraged by naming exactly what the visible
          // answer should start with, not by asking the model to "write text".
          ask: `${plan.ask}\n\nReminder: reply with the summary text itself. Do not call any tools, do not write tool-call syntax, do not leave the summary in your reasoning, and do not end your turn before writing it — start with the summary's first heading.`,
        }
        const retryStartedAt = Date.now()
        try {
          response = await generateSummary(
            pi,
            ctx,
            event,
            options,
            summarizer,
            reasoningEffort,
            retryPlan,
            recordSummaryPayload,
            requestHeaders,
          )
          rejection = summaryRejection(response)
          log.record("summary_retry", {
            sessionId,
            durationMs: Date.now() - retryStartedAt,
            stopReason: response.stopReason,
            blocks: describeContent(response.content, options.debugPayloads === true),
            cacheRead: response.usage.cacheRead,
            reason: rejection,
          })
        } catch (error) {
          log.record("summary_retry", { sessionId, error: String(error) })
          rejection = String(error)
        }
      }
      if (rejection) {
        recordCacheOutcome(response.usage)
        log.both("summary rejected; leaving compaction to Pi", {
          sessionId,
          reason: rejection,
          stopReason: response.stopReason,
          usage: response.usage,
          blocks: describeContent(response.content, options.debugPayloads === true),
        })
        return
      }
      // Pi appends a machine-computed file list to every summary; the model's
      // text is only the prose part. Mirroring it keeps summaries identical in
      // shape whichever path produced them.
      const { readFiles, modifiedFiles } = computeFileLists(event.preparation.fileOps)
      const summary = extractSummaryText(response.content) + formatFileOperations(readFiles, modifiedFiles)
      recordCacheOutcome(response.usage)
      log.both("wrote cache-friendly summary", {
        sessionId,
        chars: summary.length,
        cacheRead: response.usage.cacheRead,
        cacheWrite: response.usage.cacheWrite,
        input: response.usage.input,
        durationMs: Date.now() - startedAt,
        summarizer: `${summarizer.provider}/${summarizer.id}`,
      })
      log.record("summary_result", {
        sessionId,
        askHash,
        durationMs,
        stopReason: response.stopReason,
        chars: summary.length,
        usage: response.usage,
        cacheRead: response.usage.cacheRead,
        cacheWrite: response.usage.cacheWrite,
      })
      return {
        compaction: {
          summary,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          usage: response.usage,
          details: { readFiles, modifiedFiles },
        },
      }
    } catch (error) {
      log.both("summary request failed; leaving compaction to Pi", {
        sessionId,
        error: String(error),
      })
      return
    }
  })
}
