import { test } from "node:test"
import assert from "node:assert/strict"

import {
  activeToolDeclarations,
  buildSummaryContext,
  computeFileLists,
  continuationFits,
  extractLiveReasoningEffort,
  extractSummaryText,
  formatFileOperations,
  isModelAllowed,
  PI_TURN_PREFIX_FORMAT,
  PI_TURN_PREFIX_PROMPT,
  summaryOutputCap,
  tokenScale,
  looksLikeToolCall,
  messageSnippet,
  messagesBeforeEntry,
  planSummaryRequest,
  promptTokensOf,
  renderSummaryAsk,
  replayableHeaders,
  resolveSummaryReasoningEffort,
  summaryRejection,
} from "../src/build.ts"

test("messagesBeforeEntry returns exactly the messages compaction will drop", () => {
  const entries = [
    { sourceEntry: { id: "sys" }, messages: [{ role: "system", content: "SYS" }] },
    { sourceEntry: { id: "u1" }, messages: [{ role: "user", content: "old" }] },
    { sourceEntry: { id: "a1" }, messages: [{ role: "assistant", content: [{ type: "text", text: "old reply" }] }] },
    { sourceEntry: { id: "keep" }, messages: [{ role: "user", content: "recent kept" }] },
  ]
  const dropped = messagesBeforeEntry(entries, "keep") as any[]
  assert.deepEqual(
    dropped.map((message) => message.content),
    ["SYS", "old", [{ type: "text", text: "old reply" }]],
  )
})

test("messagesBeforeEntry returns undefined when the kept entry is not in the projection", () => {
  assert.equal(messagesBeforeEntry([{ sourceEntry: { id: "a" }, messages: [] }], "missing"), undefined)
})

test("renderSummaryAsk falls back to the default prompt and appends custom instructions", () => {
  assert.match(renderSummaryAsk({}), /structured context checkpoint summary/i)
  assert.ok(renderSummaryAsk({ summaryPrompt: "  Custom ask  " }).startsWith("Custom ask\n"))
  assert.equal(
    renderSummaryAsk({ summaryPrompt: "Custom ask", focus: "  focus on tests  " }),
    "Custom ask\n\nDo not call any tools. Reply with the summary itself, never with a tool call.\n\nAdditional focus: focus on tests",
  )
})

test("activeToolDeclarations keeps only active tools, in Pi's order", () => {
  const all = [
    { name: "read", description: "read a file", parameters: { type: "object" }, sourceInfo: {} },
    { name: "bash", description: "run a command", parameters: { type: "object" }, sourceInfo: {} },
  ] as any
  const declarations = activeToolDeclarations(all, ["bash", "missing", "read"])
  assert.deepEqual(
    declarations.map((tool) => tool.name),
    ["bash", "read"],
  )
  assert.equal(declarations[0].description, "run a command")
})

test("buildSummaryContext appends exactly one user turn and does not mutate its input", () => {
  const messages = [{ role: "user", content: "hello", timestamp: 1 }] as any
  const context = buildSummaryContext({
    systemPrompt: "SYS",
    tools: [{ name: "read", description: "r", parameters: {} }] as any,
    messages,
    ask: "SUMMARIZE",
    now: 42,
  })

  assert.equal(context.systemPrompt, "SYS")
  assert.equal(context.messages.length, 2)
  assert.equal(messages.length, 1)
  const last = context.messages[1] as any
  assert.equal(last.role, "user")
  assert.equal(last.content[0].text, "SUMMARIZE")
  assert.equal(last.timestamp, 42)
})

test("extractSummaryText joins text blocks and ignores thinking and tool calls", () => {
  const content = [
    { type: "thinking", thinking: "hmm" },
    { type: "text", text: " first " },
    { type: "text", text: "second" },
    { type: "toolCall", id: "1", name: "read", arguments: {} },
  ] as any
  assert.equal(extractSummaryText(content), "first \nsecond")
})

test("summaryRejection accepts a plain text stop", () => {
  assert.equal(
    summaryRejection({ stopReason: "stop", content: [{ type: "text", text: "ok" }] as any }),
    undefined,
  )
})

test("summaryRejection rejects empty, truncated, aborted, errored, and tool-calling replies", () => {
  assert.match(
    summaryRejection({ stopReason: "stop", content: [{ type: "text", text: "   " }] as any })!,
    /no summary text/,
  )
  assert.match(
    summaryRejection({ stopReason: "length", content: [{ type: "text", text: "partial" }] as any })!,
    /token cap/,
  )
  assert.match(
    summaryRejection({ stopReason: "aborted", content: [] as any })!,
    /aborted/,
  )
  assert.match(
    summaryRejection({ stopReason: "error", content: [], errorMessage: "boom" } as any)!,
    /boom/,
  )
  assert.match(
    summaryRejection({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }] as any,
    })!,
    /call a tool/,
  )
})

test("extractLiveReasoningEffort reads the effort actually on the wire", () => {
  assert.equal(extractLiveReasoningEffort({ reasoning_effort: "medium" }), "medium")
  // openrouter-style nested effort
  assert.equal(extractLiveReasoningEffort({ reasoning: { effort: "low" } }), "low")
  // Object payloads are complete truth: no effort field means the live
  // request omitted it — a distinct cache variant, not "unknown".
  assert.equal(extractLiveReasoningEffort({ model: "m" }), null)
  assert.equal(extractLiveReasoningEffort({ reasoning_effort: 42 }), null)
  assert.equal(extractLiveReasoningEffort({ reasoning: "stringy" }), null)
  // Only non-object payloads are unobservable.
  assert.equal(extractLiveReasoningEffort(undefined), undefined)
  assert.equal(extractLiveReasoningEffort("nope"), undefined)
})

test("resolveSummaryReasoningEffort prefers config, mirrors observation otherwise", () => {
  assert.equal(resolveSummaryReasoningEffort("minimal", "high"), "minimal")
  assert.equal(resolveSummaryReasoningEffort(undefined, "high"), "high")
  // live omitted, and never observed, both mean "omit the key"
  assert.equal(resolveSummaryReasoningEffort(undefined, null), undefined)
  assert.equal(resolveSummaryReasoningEffort(undefined, undefined), undefined)
})

test("isModelAllowed treats an empty list as every model", () => {
  assert.equal(isModelAllowed(undefined, "mock", "m"), true)
  assert.equal(isModelAllowed([], "mock", "m"), true)
  assert.equal(isModelAllowed(["mock/m"], "mock", "m"), true)
  assert.equal(isModelAllowed(["other/m"], "mock", "m"), false)
})

test("replayableHeaders keeps custom headers and drops transport-managed ones", () => {
  const replayed = replayableHeaders({
    "x-session-affinity": "aff-123",
    "User-Agent": "pi/1.2.3",
    authorization: "Bearer secret",
    "content-length": "99999",
    connection: "keep-alive",
    "transfer-encoding": "chunked",
    host: "example.com",
    "accept-encoding": "gzip",
  })
  assert.deepEqual(replayed, {
    "x-session-affinity": "aff-123",
    "User-Agent": "pi/1.2.3",
    authorization: "Bearer secret",
  })
})

test("replayableHeaders drops null deletions and returns undefined when nothing remains", () => {
  assert.deepEqual(
    replayableHeaders({ "x-removed": null, "content-length": "1", "x-kept": "v" }),
    { "x-kept": "v" },
  )
  assert.equal(replayableHeaders(undefined), undefined)
  assert.equal(replayableHeaders({}), undefined)
  assert.equal(replayableHeaders({ connection: "keep-alive" }), undefined)
})

test("renderSummaryAsk appends a boundary note only when given one", () => {
  const plain = renderSummaryAsk({})
  assert.match(plain, /context checkpoint summary/i)
  assert.doesNotMatch(plain, /stay in the context verbatim/)

  const scoped = renderSummaryAsk({ boundary: { keptCount: 2, role: "assistant", snippet: "hi there" } })
  assert.ok(scoped.startsWith(plain))
  assert.match(scoped, /2 later message\(s\) stay in the context verbatim/)
  assert.match(scoped, /up to and including the assistant message that begins/)
  assert.match(scoped, /"hi there"/)

  // Focus text and the boundary coexist; the boundary stays last so it is the
  // most recently read instruction.
  const both = renderSummaryAsk({ focus: "focus on tests", boundary: { keptCount: 1, role: "user", snippet: "x" } })
  assert.ok(both.indexOf("Additional focus: focus on tests") < both.indexOf("stay in the context verbatim"))
})

test("messageSnippet collapses whitespace, reads text blocks, and truncates", () => {
  assert.equal(messageSnippet("  hello\n\n  world "), "hello world")
  assert.equal(messageSnippet([{ type: "text", text: "a" }, { type: "thinking", text: "b" }, { type: "text", text: "c" }]), "a c")
  assert.equal(messageSnippet([{ type: "toolCall", name: "read" }]), "")
  assert.equal(messageSnippet(undefined), "")
  const long = "z".repeat(500)
  const snippet = messageSnippet(long, 40)
  assert.equal(snippet.length, 41) // 40 + the ellipsis
  assert.ok(snippet.endsWith("…"))
})

test("promptTokensOf sums the server-reported prompt, assistant messages only", () => {
  assert.equal(promptTokensOf({ role: "assistant", usage: { input: 16, cacheRead: 109915, cacheWrite: 0 } }), 109931)
  assert.equal(promptTokensOf({ role: "toolResult", usage: { input: 5 } }), undefined)
  assert.equal(promptTokensOf({ role: "assistant" }), undefined)
  assert.equal(promptTokensOf("nope"), undefined)
  // A zeroed usage record is not a usable report — reading it as 0 would let an
  // oversized continuation through the guard.
  assert.equal(promptTokensOf({ role: "assistant", usage: { input: 0, cacheRead: 0, cacheWrite: 0 } }), undefined)
})

test("continuationFits uses reported usage for the bulk and estimates the delta", () => {
  const messages = [
    { role: "system", content: "S".repeat(400) },
    { role: "user", content: "u" },
    { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 10, cacheRead: 90_000, cacheWrite: 0 } },
  ]
  // 90_010 reported + a tiny delta, comfortably inside 131k minus 8k.
  assert.equal(continuationFits({ contextWindow: 131_072, maxTokens: 8192, messages, ask: "summarize" }), true)
  // Same request against a window it cannot fit.
  assert.equal(continuationFits({ contextWindow: 40_000, maxTokens: 8192, messages, ask: "summarize" }), false)
  // Unknown window: allowed rather than disabling the cache-friendly shape.
  assert.equal(continuationFits({ contextWindow: undefined, maxTokens: 8192, messages, ask: "x" }), true)
  // No usage anywhere: the whole request is estimated from bytes.
  const noUsage = [{ role: "user", content: "x".repeat(3000) }]
  assert.equal(continuationFits({ contextWindow: 131_072, maxTokens: 8192, messages: noUsage, ask: "x" }), true)
  assert.equal(continuationFits({ contextWindow: 1000, maxTokens: 100, messages: noUsage, ask: "x" }), false)
})

test("planSummaryRequest picks the continuation and names the boundary", () => {
  const droppedMessages: any[] = [
    { role: "system", content: "SYS" },
    { role: "user", content: "do the thing" },
    { role: "assistant", content: [{ type: "text", text: "done, and here is why" }] },
  ]
  const liveMessages: any[] = [...droppedMessages, { role: "user", content: "and now this" }]

  const plan = planSummaryRequest({
    liveMessages,
    requestMessages: liveMessages,
    droppedMessages,
    options: {},
    contextWindow: 131_072,
    maxTokens: 8192,
  })
  assert.equal(plan.shape, "continuation")
  assert.equal(plan.messages, liveMessages)
  assert.equal(plan.droppedMessages, droppedMessages)
  assert.deepEqual(plan.boundary, { keptCount: 1, role: "assistant", snippet: "done, and here is why" })
  assert.match(plan.ask, /stay in the context verbatim/)

  // continuation: false is the old request shape, and needs no boundary note.
  const rewound = planSummaryRequest({
    liveMessages,
    requestMessages: liveMessages,
    droppedMessages,
    options: { continuation: false },
    contextWindow: 131_072,
    maxTokens: 8192,
  })
  assert.equal(rewound.shape, "dropped")
  assert.equal(rewound.messages, droppedMessages)
  assert.equal(rewound.boundary, undefined)
  assert.doesNotMatch(rewound.ask, /stay in the context verbatim/)


  // A continuation that cannot fit falls back to the dropped span — but only
  // when the smaller shape is the one that fits.
  const bigTail: any[] = [...droppedMessages, { role: "user", content: "x".repeat(30_000) }]
  const small = planSummaryRequest({
    liveMessages: bigTail,
    requestMessages: bigTail,
    droppedMessages,
    options: {},
    contextWindow: 1000,
    maxTokens: 100,
  })
  assert.equal(small.shape, "dropped")
  assert.equal(small.messages, droppedMessages)

  // When neither shape fits, keep the cache-friendly one: the request is going
  // to be rejected either way, and Pi's own fallback summary is larger still.
  const hopeless = planSummaryRequest({
    liveMessages,
    requestMessages: liveMessages,
    droppedMessages,
    options: {},
    contextWindow: 100,
    maxTokens: 50,
  })
  assert.equal(hopeless.shape, "continuation")
  assert.equal(hopeless.messages, liveMessages)
})

test("planSummaryRequest continues the last live request when the projection is too big", () => {
  // The production case: a 100 KB tool result arrives after the last request, so
  // the whole projection no longer fits the window — but the request the server
  // has cached still does, and appending the ask to *it* is still a forward
  // continuation.
  const droppedMessages: any[] = [
    { role: "system", content: "SYS" },
    { role: "user", content: "do the thing" },
    { role: "assistant", content: [{ type: "text", text: "working" }], usage: { input: 1000, cacheRead: 40_000 } },
  ]
  const requestMessages: any[] = [...droppedMessages, { role: "toolResult", content: "small output" }]
  const liveMessages: any[] = [...requestMessages, { role: "toolResult", content: "x".repeat(200_000) }]

  const plan = planSummaryRequest({
    liveMessages,
    requestMessages,
    droppedMessages,
    keptCount: liveMessages.length - droppedMessages.length,
    options: {},
    contextWindow: 131_072,
    maxTokens: 8192,
  })
  assert.equal(plan.shape, "continuation-request")
  assert.equal(plan.messages, requestMessages)
  // The boundary counts every message the conversation keeps, including the
  // oversized ones that are not in the request.
  assert.equal(plan.boundary?.keptCount, 2)
  assert.match(plan.ask, /2 later message\(s\) stay in the context verbatim/)
})

test("planSummaryRequest continues the whole projection when it fits", () => {
  const droppedMessages: any[] = [
    { role: "system", content: "SYS" },
    { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1000, cacheRead: 40_000 } },
  ]
  const requestMessages: any[] = [...droppedMessages, { role: "user", content: "small" }]
  const liveMessages: any[] = [...requestMessages, { role: "assistant", content: [{ type: "text", text: "reply" }] }]
  const plan = planSummaryRequest({
    liveMessages,
    requestMessages,
    droppedMessages,
    options: {},
    contextWindow: 131_072,
    maxTokens: 8192,
  })
  // Prefer the most complete continuation: it extends the checkpoint including
  // the reply the server generated.
  assert.equal(plan.shape, "continuation")
  assert.equal(plan.messages, liveMessages)
})

test("planSummaryRequest falls back when the projection is already the dropped span", () => {
  const messages: any[] = [{ role: "system", content: "SYS" }, { role: "user", content: "hi" }]
  const plan = planSummaryRequest({
    liveMessages: messages,
    requestMessages: messages,
    droppedMessages: messages,
    options: {},
    contextWindow: 131_072,
    maxTokens: 8192,
  })
  // The dropped span already *is* the last live request, so the bytes sent are a
  // forward continuation; the label has to say so (see the test below).
  assert.equal(plan.shape, "continuation-request")
  assert.equal(plan.messages, messages)
})

test("resolveSummaryReasoningEffort passes \"none\" through and omits for \"off\"", () => {
  // llama.cpp documents `reasoning_effort: "none"` as disabling reasoning, and
  // unlike the other levels it is not given to the chat template — which is why
  // it is the cache-safe way to stop a thinking-only reply.
  assert.equal(resolveSummaryReasoningEffort("none", "medium"), "none")
  assert.equal(resolveSummaryReasoningEffort("off", "medium"), undefined)
})

test("resolveSummaryReasoningEffort treats \"off\" as omitting the field", () => {
  // The mirror is the default; "off" must beat it and produce no field at all.
  assert.equal(resolveSummaryReasoningEffort(undefined, "medium"), "medium")
  assert.equal(resolveSummaryReasoningEffort("off", "medium"), undefined)
  assert.equal(resolveSummaryReasoningEffort("minimal", "medium"), "minimal")
  assert.equal(resolveSummaryReasoningEffort(undefined, null), undefined)
})

test("the default ask gives an explicit skeleton and a starting point", () => {
  // Pi's compaction prompt hands the model a literal format ("Use this EXACT
  // format: ## Goal ..."), which is the believable reason its summaries always
  // come back as text. A reply that stops inside the reasoning channel is what
  // we are defending against, so the first ask needs the same anchor.
  const ask = renderSummaryAsk({})
  // Pi's own prompt, verbatim, is the base: "Use this EXACT format:" with the
  // section skeleton underneath.
  assert.match(ask, /Use this EXACT format:/)
  assert.match(ask, /^## Goal$/m)
  assert.match(ask, /^## Next Steps$/m)
  // Pi's prompt does not forbid tool calls in words — it relies on rejecting a
  // tool-call reply, and this extension also asks the provider for
  // `tool_choice: "none"` because the tools must stay declared for the cache.
})

test("renderSummaryAsk mirrors Pi's split-turn artifact", () => {
  const ask = renderSummaryAsk({
    boundary: { keptCount: 5, role: "assistant", snippet: "start of history end" },
    split: { boundary: { keptCount: 5, role: "toolResult", snippet: "tail of the turn" }, hasHistory: true },
  })
  // Pi writes `${history}\n\n---\n\n**Turn Context (split turn):**\n\n${prefix}`.
  assert.match(ask, /\*\*Turn Context \(split turn\):\*\*/)
  assert.match(ask, /write exactly ---/)
  // The second part uses Pi's turn-prefix *format* — headings and placeholders
  // only. His prose is not embedded: handed instructions inline, the model
  // echoed them into the persisted summary.
  assert.match(ask, /^## Original Request$/m)
  assert.match(ask, /^## Context for Suffix$/m)
  assert.match(ask, /do not repeat any of these instructions/)
  assert.doesNotMatch(ask, /This is the PREFIX of a turn that was too large to keep/)
  // Drift guard: the embedded format is Pi's, line for line.
  for (const line of PI_TURN_PREFIX_FORMAT.split("\n").filter((l) => l.trim())) {
    assert.ok(PI_TURN_PREFIX_PROMPT.includes(line), `Pi's prompt no longer contains: ${line}`)
  }
  // Both scope anchors are present, and the retained suffix is called out.
  assert.match(ask, /"start of history end"/)
  assert.match(ask, /"tail of the turn"/)
  assert.match(ask, /retained suffix, and must NOT be covered/)

  // No history before the turn: Pi renders that as "No prior history.".
  const noHistory = renderSummaryAsk({
    split: { boundary: { keptCount: 2, role: "user", snippet: "the ask" }, hasHistory: false },
  })
  assert.match(noHistory, /reply with exactly "No prior history."/)
  // ...and with nothing to summarize first, there is no history scope anchor.
  assert.doesNotMatch(noHistory, /Do not cover anything after that point here/)
})

test("renderSummaryAsk uses Pi's update prompt when a summary already exists", () => {
  const fresh = renderSummaryAsk({})
  const update = renderSummaryAsk({ previous: true })
  assert.notEqual(fresh, update)
  assert.match(update, /NEW conversation messages to incorporate into the existing summary/)
  assert.match(update, /PRESERVE all existing information from the previous summary/)
  // Both keep Pi's section skeleton, so the artifact stays the same shape.
  assert.match(update, /^## Next Steps$/m)
})

test("computeFileLists and formatFileOperations mirror Pi's appendix", () => {
  const { readFiles, modifiedFiles } = computeFileLists({
    read: ["b.ts", "a.ts", "edited.ts"],
    written: ["new.ts"],
    edited: ["edited.ts"],
  })
  assert.deepEqual(readFiles, ["a.ts", "b.ts"])
  assert.deepEqual(modifiedFiles, ["edited.ts", "new.ts"])
  assert.equal(
    formatFileOperations(readFiles, modifiedFiles),
    "\n\n<read-files>\na.ts\nb.ts\n</read-files>\n\n<modified-files>\nedited.ts\nnew.ts\n</modified-files>",
  )
  assert.equal(formatFileOperations([], []), "")
  // A host without file tracking lists nothing rather than throwing.
  assert.deepEqual(computeFileLists(undefined), { readFiles: [], modifiedFiles: [] })
})

test("a dropped span that is the last live request is labelled a continuation", () => {
  // The tiny-session case: nothing was retained, so the dropped span and the
  // last live request are the same messages. Those bytes are still a forward
  // continuation, and reporting them as the rewinding shape would mislead
  // exactly the debugging that relies on `requestShape`.
  const messages: any[] = [
    { role: "system", content: "SYS" },
    { role: "user", content: "hello" },
  ]
  const plan = planSummaryRequest({
    liveMessages: messages,
    requestMessages: messages,
    droppedMessages: messages,
    keptCount: 0,
    options: {},
    contextWindow: 131_072,
    maxTokens: 8192,
  })
  assert.equal(plan.shape, "continuation-request")
  // Nothing is retained, so there is nothing to scope the model away from.
  assert.equal(plan.boundary, undefined)
  assert.doesNotMatch(plan.ask, /stay in the context verbatim/)
})

test("summaryRejection refuses tool-call syntax written as text", () => {
  // Observed for real: a continuation made the model answer by acting, and the
  // provider reported `<tool_call>…` as an ordinary text block. It must not
  // become the conversation prefix.
  const asText = {
    stopReason: "stop",
    content: [{ type: "text", text: '<tool_call>\n<function=bash>\n<parameter=command>ls\n</tool_call>' }],
  } as any
  assert.match(summaryRejection(asText) ?? "", /tool call instead of a summary/)
  assert.equal(looksLikeToolCall('<tool_call><function=bash>'), true)
  assert.equal(looksLikeToolCall("<|tool_call|>"), true)
  assert.equal(looksLikeToolCall("[tool_call]"), true)
  // A real summary that merely mentions tools is fine.
  assert.equal(
    summaryRejection({ stopReason: "stop", content: [{ type: "text", text: "## Goal\nFix the tool call handling in `bash`." }] } as any),
    undefined,
  )
  assert.equal(looksLikeToolCall("## Goal\nFix the tool call handling."), false)
})

test("summaryOutputCap derives Pi's ceiling, bounded by what is reclaimed", () => {
  // Pi's rule with default settings: 0.8 x 16,384.
  assert.equal(summaryOutputCap({}), 13_107)
  assert.equal(summaryOutputCap({ reserveTokens: 8192 }), 6553)
  // ...clamped by the model's own output limit.
  assert.equal(summaryOutputCap({ modelMaxTokens: 4096 }), 4096)
  // ...and bounded by half of what the compaction drops, so a checkpoint can
  // never be larger than what it replaces (Pi's split-turn concatenation can
  // reach 1.3x its reserve; this cannot).
  assert.equal(summaryOutputCap({ droppedTokens: 200_000 }), 13_107) // generous case: Pi's cap
  assert.equal(summaryOutputCap({ droppedTokens: 8000 }), 4000) // small drop: tighter
  assert.equal(summaryOutputCap({ droppedTokens: 100 }), 2048) // floor for thinking tokens
  // An explicit config value skips all of it.
  assert.equal(summaryOutputCap({ configured: 333, droppedTokens: 100 }), 333)
  // No reserve information at all: still Pi's shape of answer, not a crash.
  assert.equal(summaryOutputCap({ reserveTokens: undefined, modelMaxTokens: undefined }), 13_107)
})

test("tokenScale calibrates byte estimates against the server's own count", () => {
  // A tiny reported prompt with a huge byte estimate (blob-heavy content): the
  // ratio pulls estimates down toward reality.
  const blob = "x".repeat(30_000)
  const calibrated = [
    { role: "user", content: blob },
    { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 100, cacheRead: 0, cacheWrite: 0 } },
  ]
  const scale = tokenScale(calibrated as any)
  assert.ok(scale < 0.2 + 1e-9 || scale === 0.2, `expected a strongly correcting scale, got ${scale}`)

  // Agreement between the two means no meaningful correction (the estimate is
  // only accurate to its own JSON overhead, hence the tolerance).
  const agreeing = [
    { role: "user", content: "y".repeat(3000) },
    { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 1000, cacheRead: 0, cacheWrite: 0 } },
  ]
  assert.ok(Math.abs(tokenScale(agreeing as any) - 1) < 0.05)

  // No reported usage anywhere: no correction, and no throw.
  assert.equal(tokenScale([{ role: "user", content: "hello" }] as any), 1)
})

test("calibration changes what fits", () => {
  // The content *after* the reported message is the part we have to estimate,
  // and it is the part a bad ratio distorts. The reported prompt covers
  // everything before it exactly, so only that tail is in question.
  const messages: any[] = [
    { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 6000, cacheRead: 0, cacheWrite: 0 } },
    { role: "user", content: "y".repeat(60_000) },
  ]
  const args = { contextWindow: 30_000, maxTokens: 4096, messages, ask: "summarize" }
  assert.equal(continuationFits(args), false) // ~20k estimated tokens for 60kB
  assert.equal(continuationFits({ ...args, scale: 0.1 }), true) // calibrated down
})
