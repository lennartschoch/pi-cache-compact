/**
 * Pure, dependency-light helpers for pi-cache-compact.
 *
 * Kept free of runtime SDK imports so the unit tests can exercise the real
 * logic without booting Pi. Everything imported here is a type and is erased
 * when Node strips types.
 */

import type { AssistantMessage, Message, Tool } from "@earendil-works/pi-ai"
import type { ToolInfo } from "@earendil-works/pi-coding-agent"

/**
 * Pi's compaction prompts, copied verbatim from
 * `@earendil-works/pi-coding-agent` `dist/core/compaction/compaction.js` (v0.87.0),
 * so the summary persisted here is the artifact Pi's own compaction would have
 * written. The package does not export them, hence the copy: if Pi changes its
 * summary format, copy the new text over.
 *
 * The deliberate deviations from Pi live elsewhere — in what the model gets to
 * read (the real messages, never a truncated serialization) and in how the
 * request is shaped (a continuation of the live conversation, so a
 * prefix-caching server serves it from cache).
 */
export const PI_SUMMARY_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

export const PI_UPDATE_SUMMARY_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

export const PI_TURN_PREFIX_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`

/**
 * The format half of Pi's turn-prefix prompt, embedded in our single-request
 * ask. Pi sends the whole text as the instruction of a *separate* call, so with
 * him there is nothing to echo; with both parts asked for in one reply, a model
 * handed prose instructions inline copies them into the artifact (observed:
 * "This is the PREFIX of a turn that was too large to keep." landed in the
 * persisted summary). A test asserts these lines still match Pi's prompt, so
 * drift shows up as a failure rather than a quiet artifact change.
 */
export const PI_TURN_PREFIX_FORMAT = `## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]`

/** Pi's heading for the retained part of a split turn, and its empty-history text. */
export const PI_SPLIT_MARKER = "**Turn Context (split turn):**"
export const PI_NO_HISTORY = "No prior history."

export type SummaryPromptOptions = {
  /** Replace Pi's handoff instruction. */
  summaryPrompt?: string
}

/**
 * Where the summary should stop, when the request also contains messages that
 * stay in the context.
 *
 * Appending the ask to the live conversation is what keeps the request a
 * forward continuation (see `continuation` in config.ts) — but Pi still keeps
 * the recent tail verbatim, so a summary that covers it too would describe
 * those messages twice. The boundary is named in the ask so the model can leave
 * the tail out while the *request* stays cache-friendly.
 */
export type SummaryBoundary = {
  /** Messages after the boundary that remain in the context verbatim. */
  keptCount: number
  /** Role of the last message the summary should cover. */
  role: string
  /** Opening words of that message, so the model can locate it exactly. */
  snippet: string
}

export type SummaryAskArgs = SummaryPromptOptions & {
  /** The request also carries a previous summary: use Pi's update prompt. */
  previous?: boolean
  /** What the summary covers, when later messages stay in the context. */
  boundary?: SummaryBoundary
  /**
   * A split turn: the dropped span contains the start of a turn whose end is
   * retained, so Pi's artifact has a second section under
   * `**Turn Context (split turn):**`. `hasHistory` is false when there was
   * nothing before the turn, which Pi renders as "No prior history.".
   */
  split?: { boundary: SummaryBoundary; hasHistory: boolean }
  /** Extra focus from the caller (`customInstructions`). */
  focus?: string
}

/**
 * Compose the user turn that asks for the summary.
 *
 * The base text is Pi's own (`summaryPrompt` overrides it), and for a split
 * turn the ask describes both parts Pi would write, in Pi's order and with
 * Pi's headings — so the persisted artifact matches Pi's format whether or not
 * this extension produced it. Only the *scope* notes are ours: the request is a
 * continuation, so it also contains messages that stay in the context and the
 * model has to be told where to stop.
 */
export function renderSummaryAsk(args: SummaryAskArgs = {}): string {
  const base =
    args.summaryPrompt?.trim() ||
    (args.previous ? PI_UPDATE_SUMMARY_PROMPT : PI_SUMMARY_PROMPT)
  const parts = [
    base,
    // Pi's prompt does not say this (Pi declares no tools at all, so its model
    // cannot be tempted). This extension must keep the tools declared for the
    // cache, and a model that answers by *acting* — or by writing tool-call
    // syntax as text, which the provider reports as an ordinary text block —
    // would otherwise have that text persisted as the conversation prefix.
    "Do not call any tools. Reply with the summary itself, never with a tool call.",
  ]
  const focus = args.focus?.trim()
  if (focus) parts.push(`Additional focus: ${focus}`)

  const scope = (boundary: SummaryBoundary, closing: string): string =>
    `Cover the conversation only up to and including the ${boundary.role} message that begins:\n\n"${boundary.snippet}"\n\n${closing}`

  if (args.split) {
    if (args.boundary) {
      parts.push(scope(args.boundary, "Do not cover anything after that point here."))
    }
    if (!args.split.hasHistory) {
      parts.push(
        `If there is nothing to summarize before the turn below, reply with exactly "${PI_NO_HISTORY}" instead of the format above.`,
      )
    }
    parts.push(
      [
        `Then, on a new line, write exactly --- and on the line after it exactly "${PI_SPLIT_MARKER}", followed by a summary of the part of the turn that was too large to keep.`,
        "Use these headings and replace each bracketed placeholder with real content; do not repeat any of these instructions:",
        PI_TURN_PREFIX_FORMAT,
      ].join("\n\n"),
    )
    parts.push(
      scope(
        args.split.boundary,
        `${args.split.boundary.keptCount} later message(s) stay in the context verbatim as the retained suffix, and must NOT be covered by either part of the summary.`,
      ),
    )
    return parts.join("\n\n")
  }

  if (args.boundary) {
    parts.push(
      scope(
        args.boundary,
        `The conversation does not end here: ${args.boundary.keptCount} later message(s) stay in the context verbatim and must NOT be covered by this summary.`,
      ),
    )
  }
  return parts.join("\n\n")
}

/**
 * First `limit` characters of a message's visible text, whitespace collapsed —
 * enough for a model to locate the message in its own context.
 */
export type SummaryRequestShape = "continuation" | "continuation-request" | "dropped"

export type SummaryRequestPlan = {
  /** Messages the request sends, ask excluded. */
  messages: Message[]
  /** What compaction drops — what the summary text should cover. */
  droppedMessages: Message[]
  /** The appended user turn, scope notes and split-turn structure included. */
  ask: string
  /** Which shape was chosen (see `SummaryRequestShape`). */
  shape: SummaryRequestShape
  /**
   * True when the chosen shape is the rewind because no continuation fitted —
   * as opposed to `continuation: false`, where the caller asked for it. A
   * rewind never hit a cache in any measurement and costs a whole cold
   * prefill, so the caller may prefer Pi's own small summary instead.
   */
  rewindFallback: boolean
  /** Output ceiling for this request, resolved by `summaryOutputCap`. */
  maxTokens: number
  boundary?: SummaryBoundary
  /** Present for a split turn: the ask carries both parts Pi would write. */
  split?: { boundary: SummaryBoundary; hasHistory: boolean }
}

/**
 * Decide the summarization request in one place, so the ask hash the
 * `before_provider_request` fallback matches is the ask that is actually sent.
 *
 * Three shapes, tried in order of how much of the live conversation they carry:
 *
 * 1. `continuation` — the whole projection. Extends the checkpoint the server
 *    holds *including* the reply it generated, so it is the safest bet for
 *    cache reuse, and the largest: a big tool result appended after the last
 *    request can push it past the context window on its own.
 * 2. `continuation-request` — the messages of the last live request. The server
 *    evaluated exactly these tokens, so appending the ask is still a strict
 *    forward continuation, without the (possibly huge) messages that arrived
 *    after it. This is the shape that fits when a 100 KB tool result just
 *    pushed the conversation over the compaction threshold.
 * 3. `dropped` — the span compaction discards. A rewind: on an append-only
 *    cache it re-prefills everything. Last resort, and the only shape used when
 *    `continuation: false`.
 *
 * The first shape that fits wins; if none fits, the first is used anyway (the
 * request is going to be rejected either way, and Pi's own fallback summary is
 * larger still). `dropped` is only chosen when it is the shape that fits.
 *
 * Messages arrive already converted because `convertToLlm` is a runtime import
 * and this module stays pure (type-only SDK imports).
 */
export function planSummaryRequest(args: {
  /** Explicit `summaryMaxTokens` from config; overrides the derived ceiling. */
  summaryMaxTokens?: number
  /** The full projection: every message the conversation currently has. */
  liveMessages: Message[]
  /** The messages of the last live provider request (a prefix of the above). */
  requestMessages: Message[]
  droppedMessages: Message[]
  /** Messages that stay in the context verbatim after the boundary. */
  keptCount?: number
  /**
   * How many messages at the end of the dropped span belong to the current,
   * still-open turn (Pi's `turnPrefixMessages`). Non-zero makes this a split
   * turn: Pi writes the retained part under a `**Turn Context (split turn):**`
   * heading, and the ask has to describe both parts.
   */
  turnPrefixCount?: number
  /** A previous summary is part of the request: use Pi's update prompt. */
  previousSummary?: string
  options: SummaryPromptOptions & { continuation?: boolean }
  customInstructions?: string
  contextWindow?: number
  /** Explicit `summaryMaxTokens`; when absent the cap is derived below. */
  maxTokens?: number
  reserveTokens?: number
  modelMaxTokens?: number
}): SummaryRequestPlan {
  // Resolve the output ceiling once, from Pi's rule bounded by what this
  // compaction reclaims, so the fit checks and the request agree on it.
  // One scale for every estimate in this decision, calibrated against the
  // server's own reported prompt size where one is available.
  const scale = tokenScale(args.liveMessages)
  const maxTokens = summaryOutputCap({
    configured: args.summaryMaxTokens ?? args.maxTokens,
    reserveTokens: args.reserveTokens,
    modelMaxTokens: args.modelMaxTokens,
    droppedTokens: Math.ceil(estimateMessagesTokens(args.droppedMessages) * scale),
  })
  const fits = (messages: readonly unknown[]): boolean =>
    continuationFits({
      contextWindow: args.contextWindow,
      maxTokens,
      messages,
      scale,
      ask: renderSummaryAsk({
        summaryPrompt: args.options.summaryPrompt,
        previous: Boolean(args.previousSummary),
        focus: args.customInstructions,
      }),
    })

  const droppedCount = args.droppedMessages.length
  const candidates: { shape: SummaryRequestShape; messages: Message[] }[] = []
  if (args.options.continuation !== false) {
    if (args.liveMessages.length > droppedCount) {
      candidates.push({ shape: "continuation", messages: args.liveMessages })
    }
    // `>=`, not `>`: when the dropped span *is* the last live request (a tiny
    // session, or one where nothing was kept) those bytes are still a forward
    // continuation — labelling them "dropped" would report a rewinding shape
    // for a request that the server served from cache.
    if (args.requestMessages.length >= droppedCount && args.requestMessages.length > 0) {
      candidates.push({ shape: "continuation-request", messages: args.requestMessages })
    }
  }
  candidates.push({ shape: "dropped", messages: args.droppedMessages })

  const chosen =
    candidates.find((candidate) => candidate.shape !== "dropped" && fits(candidate.messages)) ??
    candidates.find((candidate) => fits(candidate.messages)) ??
    candidates[0]
  const rewindFallback = chosen.shape === "dropped" && args.options.continuation !== false

  const boundaryFor = (messages: readonly unknown[]): SummaryBoundary | undefined => {
    const last = messages[messages.length - 1]
    if (!last) return undefined
    const snippet = messageSnippet((last as { content?: unknown }).content)
    if (!snippet) return undefined
    return {
      keptCount: args.keptCount ?? chosen.messages.length - droppedCount,
      role: String((last as { role?: unknown }).role ?? "user"),
      snippet,
    }
  }

  // The scope note only matters when the request also carries messages the
  // model may not summarize: nothing is retained when the shape is `dropped`
  // (a rewind) or when the conversation kept no tail at all.
  const keptCount = args.keptCount ?? chosen.messages.length - droppedCount
  const boundary = chosen.shape !== "dropped" && keptCount > 0 ? boundaryFor(args.droppedMessages) : undefined

  let split: SummaryRequestPlan["split"]
  const turnPrefixCount = args.turnPrefixCount ?? 0
  if (turnPrefixCount > 0 && turnPrefixCount <= droppedCount) {
    const history = args.droppedMessages.slice(0, droppedCount - turnPrefixCount)
    const prefixBoundary = boundaryFor(args.droppedMessages)
    if (prefixBoundary) {
      split = {
        boundary: prefixBoundary,
        hasHistory: history.length > 0 || Boolean(args.previousSummary),
      }
    }
  }

  return {
    messages: chosen.messages,
    droppedMessages: args.droppedMessages,
    maxTokens,
    rewindFallback,
    ask: renderSummaryAsk({
      summaryPrompt: args.options.summaryPrompt,
      previous: Boolean(args.previousSummary),
      focus: args.customInstructions,
      ...(boundary ? { boundary } : undefined),
      ...(split ? { split } : undefined),
    }),
    shape: chosen.shape,
    ...(boundary ? { boundary } : undefined),
    ...(split ? { split } : undefined),
  }
}

export function messageSnippet(content: unknown, limit = 160): string {
  const blocks = Array.isArray(content) ? content : [{ type: "text", text: content }]
  const text = blocks
    .map((block) => {
      if (typeof block === "string") return block
      const record = block as { type?: unknown; text?: unknown }
      return record?.type === "text" && typeof record.text === "string" ? record.text : ""
    })
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * Keep only the tools that are active, in the order Pi reports them, and
 * project them to the provider-facing declaration. The order has to match the
 * live request or the prefix cache would miss.
 */
export function activeToolDeclarations(
  all: readonly ToolInfo[],
  activeNames: readonly string[],
): Tool[] {
  const byName = new Map(all.map((tool) => [tool.name, tool]))
  const declarations: Tool[] = []
  for (const name of activeNames) {
    const tool = byName.get(name)
    if (!tool) continue
    declarations.push({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })
  }
  return declarations
}

export type SummaryContext = {
  systemPrompt: string
  tools: Tool[]
  messages: Message[]
}

/**
 * Server-reported prompt size of the request that produced this message, when
 * the provider reported usage: the prompt is `input` (newly evaluated) plus
 * whatever came from the cache. This is the *server's* own token count — far
 * more trustworthy than any client-side estimate, which can be off by ~2x on
 * blob-heavy transcripts.
 */
export function promptTokensOf(message: unknown): number | undefined {
  if (typeof message !== "object" || message === null) return undefined
  const record = message as { role?: unknown; usage?: unknown }
  if (record.role !== "assistant" || typeof record.usage !== "object" || record.usage === null) {
    return undefined
  }
  const usage = record.usage as { input?: unknown; cacheRead?: unknown; cacheWrite?: unknown }
  const parts = [usage.input, usage.cacheRead, usage.cacheWrite]
  if (!parts.some((part) => typeof part === "number" && Number.isFinite(part))) return undefined
  const total = parts.reduce<number>(
    (sum, part) => sum + (typeof part === "number" && Number.isFinite(part) ? part : 0),
    0,
  )
  // A zeroed usage record (aborted or legacy turns) is not a usable report: a
  // reply that exists had a prompt. Returning 0 would silently disable the
  // guard and let an oversized continuation through.
  return total > 0 ? total : undefined
}

/**
 * Bytes-per-token assumed for the part of a continuation that has no reported
 * usage (the trailing assistant turn and the ask). 3 is deliberately below the
 * ~4 chars/token of English prose: high-entropy content (base64, hashes, long
 * paths) tokenizes worse, and underestimating the prompt is what turns a
 * summary into a hard `exceed_context_size_error`.
 */
const BYTES_PER_TOKEN = 3

function byteLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return String(value).length
  }
}

function estimatedTokens(value: unknown): number {
  return Math.ceil(byteLength(value) / BYTES_PER_TOKEN)
}

/**
 * How much the byte estimate over- or under-counts for this conversation.
 *
 * The reported prompt of a live request is exact, and we can estimate the same
 * messages ourselves, so their ratio calibrates every estimate we make on the
 * same conversation. `bytes / 3` is deliberately pessimistic and blob-heavy
 * transcripts came out ~3x high; a raw estimate that far off makes the fit
 * check refuse shapes that would have fit, and makes the reclaimed-size ceiling
 * inert. Clamped, because a bad ratio is worse than none: it is only ever a
 * correction to an estimate that has to stay in the same ballpark.
 */
export function tokenScale(messages: readonly unknown[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const reported = promptTokensOf(messages[index])
    if (reported === undefined) continue
    const estimated = estimateMessagesTokens(messages.slice(0, index))
    if (estimated <= 0) continue
    const ratio = reported / estimated
    if (!Number.isFinite(ratio)) continue
    return Math.min(5, Math.max(0.2, ratio))
  }
  return 1
}

/**
 * Pessimistic token estimate for a message list (see `BYTES_PER_TOKEN`).
 * Used to size the summary ceiling against what a compaction drops; the
 * precise number does not matter, only that it scales with the real content.
 */
export function estimateMessagesTokens(messages: readonly unknown[]): number {
  let total = 0
  for (const message of messages) total += estimatedTokens(message)
  return total
}

/**
 * Headroom for the part of the request that had to be estimated.
 *
 * It scales with that estimate rather than with the window: the reported prefix
 * is exact, so a fixed fraction of a 131k window would be ~6.5k of pure waste on
 * a request whose only uncertain content is the ask, and that waste is exactly
 * what stops the continuation being chosen when a conversation is near the
 * limit. Where nothing is reported the whole request is estimated, and then a
 * proportional margin is the right conservative choice.
 */
function marginFor(estimated: number, explicit: number | undefined): number {
  return explicit ?? Math.max(256, Math.ceil(estimated * 0.5))
}

/**
 * Whether the continuation request is expected to fit the server's context.
 *
 * The bulk of a continuation is the last live request's prompt, and that size
 * is known exactly: the server reported it as `usage` on the trailing assistant
 * message. Only the delta — the trailing turn plus the ask — has to be
 * estimated. Without reported usage the whole request is estimated, which is
 * pessimistic but safe.
 */
export function continuationFits(args: {
  contextWindow: number | undefined
  maxTokens: number
  messages: readonly unknown[]
  ask: string
  marginTokens?: number
  /** See `tokenScale`: multiplies the estimated (not the reported) part. */
  scale?: number
}): boolean {
  // An unknown window cannot be checked; allow it rather than disabling the
  // cache-friendly shape on every custom provider that omits the field.
  if (typeof args.contextWindow !== "number" || !Number.isFinite(args.contextWindow)) return true
  if (args.contextWindow - args.maxTokens <= 0) return false

  let reported = 0
  let reportedIndex = -1
  for (let index = args.messages.length - 1; index >= 0; index--) {
    const tokens = promptTokensOf(args.messages[index])
    if (tokens !== undefined) {
      reported = tokens
      reportedIndex = index
      break
    }
  }

  const scale = args.scale && args.scale > 0 ? args.scale : 1
  const askTokens = Math.ceil(estimatedTokens(args.ask) * scale)
  // The reported number covers the prompt *before* the message that carries it,
  // so that message counts toward the estimate along with everything after it.
  let estimated = askTokens
  if (reportedIndex < 0) {
    for (const message of args.messages) estimated += Math.ceil(estimatedTokens(message) * scale)
    return estimated + args.maxTokens + marginFor(estimated, args.marginTokens) <= args.contextWindow
  }
  for (const message of args.messages.slice(reportedIndex)) {
    estimated += Math.ceil(estimatedTokens(message) * scale)
  }
  return reported + estimated + args.maxTokens + marginFor(estimated, args.marginTokens) <= args.contextWindow
}

export interface ProjectedEntryLike {
  sourceEntry: { id: string }
  messages: readonly unknown[]
}

/**
 * The messages the live request would send before the entry Pi is about to keep.
 *
 * That span is exactly what compaction drops, so it is what the summary should
 * *describe*. It is deliberately not what the summary request *sends*: on an
 * append-only cache (llama.cpp slots) a request that rewinds to a prefix of the
 * live prompt re-prefills from scratch, while a forward continuation reuses the
 * checkpoint. The request therefore carries the whole message list and this
 * span only supplies the boundary the ask names. See `continuation` in
 * config.ts and `renderSummaryAsk`.
 *
 * Returns undefined when the boundary is not in the projection, so the caller
 * can fall back to the preparation's message lists.
 */
export function messagesBeforeEntry(
  entries: readonly ProjectedEntryLike[],
  firstKeptEntryId: string,
): unknown[] | undefined {
  const index = entries.findIndex((entry) => entry.sourceEntry?.id === firstKeptEntryId)
  if (index < 0) return undefined
  return entries.slice(0, index).flatMap((entry) => [...entry.messages])
}

/**
 * Build the summarization request: the same system prompt, the same tool
 * declarations, the conversation, then one appended user turn (the ask).
 *
 * This is the whole point of the plugin. Pi's default summary is a brand-new
 * prompt (its own system prompt, the transcript re-serialized into a single
 * user message), so a prefix-caching server must re-read the conversation. A
 * continuation of the live prompt only prefills the ask.
 *
 * The Pi session projection already embeds the leading system message (prompt
 * and tool declarations) as its first entry. Pass `systemPrompt`/`tools` only
 * when it does not — otherwise the prompt would be declared twice and the
 * prefix would no longer match.
 */
export function buildSummaryContext(args: {
  systemPrompt?: string
  tools?: Tool[]
  messages: Message[]
  ask: string
  now?: number
}): SummaryContext {
  const ask: Message = {
    role: "user",
    content: [{ type: "text", text: args.ask }],
    timestamp: args.now ?? Date.now(),
  }
  return {
    systemPrompt: args.systemPrompt ?? "",
    tools: args.tools ?? [],
    messages: [...args.messages, ask],
  }
}

/** Concatenate the visible text blocks of an assistant response. */
export function extractSummaryText(content: AssistantMessage["content"]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim()
}

export type SummaryCheck = Pick<AssistantMessage, "stopReason" | "content" | "errorMessage">

/**
 * Return a reason to reject a summary response, or `undefined` when it is safe
 * to persist. A truncated (length) or tool-calling reply must never become the
 * new conversation prefix.
 */
export function summaryRejection(response: SummaryCheck): string | undefined {
  if (response.stopReason === "error") {
    return response.errorMessage || "the provider returned an error"
  }
  if (response.stopReason === "aborted") {
    return "the summary was aborted"
  }
  if (response.stopReason === "length") {
    return "the summary hit the token cap and is incomplete"
  }
  if (response.content.some((block) => block.type === "toolCall")) {
    return "the model tried to call a tool instead of writing the summary"
  }
  if (!extractSummaryText(response.content)) {
    return NO_TEXT_REPLY
  }
  if (looksLikeToolCall(extractSummaryText(response.content))) {
    return TOOL_CALL_TEXT_REPLY
  }
  return undefined
}

/**
 * Tool-call syntax that arrived as *text* rather than as a parsed tool call.
 * Seen in practice: a model asked to summarize replied with
 * `<tool_call><function=bash><parameter=command>…` because the request is a
 * continuation and it decided to keep working. `summaryRejection` cannot catch
 * that with a `toolCall` block check, and the text would be persisted as the
 * conversation prefix.
 */
export function looksLikeToolCall(text: string): boolean {
  return /<tool_call>|<\|tool_call\|>|<function=|<tool_use>|<function_calls>|\[tool_call\]/i.test(text)
}

/**
 * The one rejection worth retrying: the model finished normally but never wrote
 * anything in the text channel (it spent the turn reasoning and stopped). Other
 * rejections — a token cap, a tool call, an error, an abort — repeat
 * deterministically, but an empty answer often comes back fine on a second
 * sample, and on a cache hit that retry costs seconds.
 */
export const NO_TEXT_REPLY = "the model returned no summary text"

/** The reply was tool-call syntax rather than a summary. Retried once: the nudge
 *  tells the model to stay in text, and a cache hit makes the retry cheap. */
export const TOOL_CALL_TEXT_REPLY = "the model replied with a tool call instead of a summary"

/**
 * The reasoning effort a live request actually put on the wire, or `null`
 * when the request sent none. On OpenAI-compatible "next"-style servers the
 * effort is rendered *into the prompt tokens*, so omitted, "low" and
 * "medium" are three distinct prefix-cache keys; the summary ask must
 * reproduce whatever the cached live prefix was sent with, not whatever the
 * user has selected right now. `undefined` means "not observable" (payload
 * is not a request object, or a non-OpenAI field layout we do not parse).
 */
export type LiveEffort = string | null

export function extractLiveReasoningEffort(payload: unknown): LiveEffort | undefined {
  // An object payload is complete truth: it either carries the effort or it
  // does not, and "does not" is itself a cache variant to reproduce.
  if (typeof payload !== "object" || payload === null) return undefined
  const record = payload as Record<string, unknown>
  // "openai" thinkingFormat uses reasoning_effort; "openrouter" uses
  // reasoning: { effort }. Any other layout (anthropic budgets, plain
  // non-thinking servers) sends no OpenAI-style effort -> null.
  if (typeof record.reasoning_effort === "string") return record.reasoning_effort
  const nested = record.reasoning
  if (typeof nested === "object" && nested !== null && typeof (nested as any).effort === "string") {
    return (nested as any).effort as string
  }
  return null
}

/**
 * Effort for the summarization request: explicit config wins; otherwise
 * mirror the last live request of the session. `null` (live sent no effort)
 * and `undefined` (never observed) both mean "omit the key", which is also
 * the pre-dynamic behaviour.
 */
export function resolveSummaryReasoningEffort(
  configured: string | undefined,
  observed: LiveEffort | undefined,
): string | undefined {
  // "off" omits the field (the server keeps its default, which for a reasoning
  // model means thinking stays on); "none" is a value the server understands as
  // "do not reason", and is deliberately *not* handed to the chat template.
  if (configured === "off") return undefined
  if (configured) return configured
  return observed ?? undefined
}

/**
 * Headers to copy from the live request onto the summarization request.
 *
 * The payload body is already mirrored byte-for-byte, but cache reuse on some
 * servers is keyed or routed by request headers (session affinity, routing
 * keys) that never appear in the payload dump. Capturing what the live
 * requests actually send — and reproducing it — removes the last
 * request-identity difference between a live turn and our ask.
 *
 * Dropped: hop-by-hop / transport-managed headers, and anything fetch would
 * reject or that would corrupt the new request (length, host, encoding...).
 * `null` deletions are dropped rather than replayed.
 */
const NON_REPLAYED_HEADERS = new Set([
  "connection",
  "content-length",
  "content-type",
  "host",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "accept-encoding",
])

export function replayableHeaders(
  headers: Record<string, string | null> | undefined | null,
): Record<string, string | null> | undefined {
  if (!headers) return undefined
  let found = false
  const out: Record<string, string | null> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (NON_REPLAYED_HEADERS.has(name.toLowerCase())) continue
    // null means "delete this header" in pi's bag; replaying that against our
    // fresh request would delete a header we need. Drop the instruction.
    if (value === null) continue
    out[name] = value
    found = true
  }
  return found ? out : undefined
}

/**
 * The output ceiling for a summary request.
 *
 * Pi derives its ceiling from the headroom it keeps below the context window —
 * `min(floor(0.8 * reserveTokens), model.maxTokens)` — and that is worth
 * keeping: a ceiling is not a target (the model only writes what it needs), so
 * a generous one costs nothing and prevents the expensive failure, a reply
 * truncated at the cap, which is rejected and throws the summary away.
 *
 * Pi's proxy is not quite the invariant it looks like, though: it never
 * references what the compaction reclaims, and for a split turn Pi applies it
 * twice (0.8 and 0.5 of the same reserve) to two concatenated summaries, so the
 * artifact can exceed the reserve it is meant to respect. So the ceiling is
 * additionally bounded by half of what this compaction drops — a checkpoint can
 * never be larger than what it replaces — with a floor for the model's thinking
 * tokens.
 */
export function summaryOutputCap(args: {
  /** `summaryMaxTokens` from config: an explicit value skips all of this. */
  configured?: number
  reserveTokens?: number
  modelMaxTokens?: number
  /** Estimated tokens in the span this compaction discards. */
  droppedTokens?: number
}): number {
  if (args.configured) return args.configured
  const piCap = Math.min(
    Math.floor(0.8 * (args.reserveTokens ?? 16_384)),
    args.modelMaxTokens && args.modelMaxTokens > 0 ? args.modelMaxTokens : Number.POSITIVE_INFINITY,
  )
  if (!args.droppedTokens || args.droppedTokens <= 0) return piCap
  const reclaimedCap = Math.max(2048, Math.floor(0.5 * args.droppedTokens))
  return Math.max(1, Math.min(piCap, reclaimedCap))
}

/** Only the shape this module needs; Pi's `FileOperations` matches it. */
export type FileOperationsLike = {
  read?: Iterable<string>
  written?: Iterable<string>
  edited?: Iterable<string>
}

/**
 * Pi's split of the session's file operations: anything written or edited is
 * "modified", and reads are the rest (sorted). Copied from Pi's compaction
 * utils so the appended list matches what its own compaction would write.
 */
export function computeFileLists(fileOps: FileOperationsLike | undefined): {
  readFiles: string[]
  modifiedFiles: string[]
} {
  // A host without file tracking (or an older Pi) simply has nothing to list.
  const modified = new Set<string>([...(fileOps?.edited ?? []), ...(fileOps?.written ?? [])])
  const readFiles = [...(fileOps?.read ?? [])].filter((file) => !modified.has(file)).sort()
  return { readFiles, modifiedFiles: [...modified].sort() }
}

/**
 * Pi's file appendix for a summary: `<read-files>` / `<modified-files>` blocks,
 * preceded by a blank line, or "" when there is nothing to list.
 */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = []
  if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`)
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`)
  }
  if (sections.length === 0) return ""
  return `\n\n${sections.join("\n\n")}`
}

/** Empty `models` means "every model". */
export function isModelAllowed(
  models: readonly string[] | undefined,
  provider: string,
  id: string,
): boolean {
  if (!models || models.length === 0) return true
  return models.includes(`${provider}/${id}`)
}
