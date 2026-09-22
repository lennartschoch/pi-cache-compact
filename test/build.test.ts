import { test } from "node:test"
import assert from "node:assert/strict"

import {
  activeToolDeclarations,
  buildSummaryContext,
  extractSummaryText,
  isModelAllowed,
  messagesBeforeEntry,
  renderSummaryAsk,
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
  assert.match(renderSummaryAsk({}), /handoff summary/i)
  assert.match(renderSummaryAsk({ summaryPrompt: "  Custom ask  " }), /^Custom ask$/)
  assert.equal(renderSummaryAsk({ summaryPrompt: "Custom ask" }, "  focus on tests  "), "Custom ask\n\nAdditional focus: focus on tests")
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

test("isModelAllowed treats an empty list as every model", () => {
  assert.equal(isModelAllowed(undefined, "mock", "m"), true)
  assert.equal(isModelAllowed([], "mock", "m"), true)
  assert.equal(isModelAllowed(["mock/m"], "mock", "m"), true)
  assert.equal(isModelAllowed(["other/m"], "mock", "m"), false)
})
