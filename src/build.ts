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
 * The instruction appended as the final user turn of the live conversation. It
 * deliberately looks like a normal turn: the model is asked to hand off, not to
 * continue, because the same tools are still advertised for the cache hit.
 */
export const DEFAULT_SUMMARY_PROMPT = `You are about to run out of context. Stop working on the task and write a complete handoff summary of this session so work can continue seamlessly from it in a fresh context.

Do not call any tools. Do not ask questions. Reply with the summary only.

Capture, as compactly as possible while keeping every specific that matters:
- The user's objective and any stated constraints or preferences.
- Key decisions and the reasoning behind them.
- Files created or changed, with paths, and what changed.
- The current state of the work and what is in progress.
- Errors or dead ends encountered and how they were resolved.
- The precise next steps.

Prefer concrete details (paths, commands, identifiers, versions) over generalities.`

export type SummaryPromptOptions = {
  /** Replace the default handoff instruction. */
  summaryPrompt?: string
}

/** Compose the user turn that asks for the summary. */
export function renderSummaryAsk(
  options: SummaryPromptOptions,
  customInstructions?: string,
): string {
  const base = options.summaryPrompt?.trim() || DEFAULT_SUMMARY_PROMPT
  const focus = customInstructions?.trim()
  return focus ? `${base}\n\nAdditional focus: ${focus}` : base
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

export interface ProjectedEntryLike {
  sourceEntry: { id: string }
  messages: readonly unknown[]
}

/**
 * The messages the live request would send before the entry Pi is about to keep.
 *
 * That span — exactly what compaction drops — is the cache-hit prefix to
 * summarize. Summarizing the *whole* context instead is wrong: Pi still keeps
 * `keepRecentTokens` of recent messages verbatim, so a whole-context summary
 * plus that tail is often larger than what it replaced, and the context grows
 * on every compaction.
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
 * Build the summarization request as a strict prefix of the live conversation,
 * followed by one user turn: the same system prompt, the same tool
 * declarations, the dropped messages, then the ask.
 *
 * This is the whole point of the plugin. Pi's default summary is a brand-new
 * prompt (its own system prompt, the transcript re-serialized into a single
 * user message), so a prefix-caching server must re-read the conversation. A
 * prefix of the live prompt only prefills the short ask.
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
    return "the model returned no summary text"
  }
  return undefined
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
