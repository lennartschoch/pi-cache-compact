import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent"
import type { AssistantMessage } from "@earendil-works/pi-ai"

import cacheCompact from "../src/extension.ts"

type Calls = {
  complete: Array<{ model: any; context: any; options: any }>
}

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "mock",
    model: "test-model",
    usage: { input: 1, output: 1, cacheRead: 5, cacheWrite: 2, totalTokens: 2, cost: {} } as any,
    stopReason,
    timestamp: Date.now(),
  }
}

function setup(config?: {
  response?: AssistantMessage | (() => Promise<AssistantMessage>)
  tools?: any[]
  activeTools?: string[]
  systemPrompt?: string
  messages?: any[]
  entries?: any[]
  // The summarizer's model shape is mirrored here; `contextWindow` drives the
  // continuation guard, so tests can make it too small to fit.
  model?: { provider: string; id: string; contextWindow?: number }
  foundModel?: any
  cwd?: string
  agentDir?: string
}) {
  const handlers = new Map<string, Function>()
  const calls: Calls = { complete: [] }
  const api = {
    on: (event: string, handler: Function) => {
      handlers.set(event, handler)
      return () => {}
    },
    getAllTools: () => config?.tools ?? [{ name: "read", description: "read", parameters: { type: "object" }, sourceInfo: {} }],
    getActiveTools: () => config?.activeTools ?? ["read"],
  } as unknown as ExtensionAPI

  const respond = async (): Promise<AssistantMessage> => {
    const response = config?.response
    if (typeof response === "function") return response()
    return response ?? assistant([{ type: "text", text: "MOCK SUMMARY" }])
  }

  const ctx = {
    cwd: config?.cwd ?? process.cwd(),
    model: config?.model ?? { provider: "mock", id: "test-model" },
    getSystemPrompt: () => config?.systemPrompt ?? "SYSTEM PROMPT",
    sessionManager: {
      buildSessionProjection: () => ({
        messages: config?.messages ?? [
          { role: "system", content: "SYSTEM PROMPT", timestamp: 0 },
          { role: "user", content: "hello from the session", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 },
          { role: "user", content: "recent kept message", timestamp: 3 },
        ],
        entries: config?.entries ?? [
          { sourceEntry: { id: "sys" }, messages: [{ role: "system", content: "SYSTEM PROMPT", timestamp: 0 }] },
          { sourceEntry: { id: "u1" }, messages: [{ role: "user", content: "hello from the session", timestamp: 1 }] },
          { sourceEntry: { id: "a1" }, messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 }] },
          { sourceEntry: { id: "keep-1" }, messages: [{ role: "user", content: "recent kept message", timestamp: 3 }] },
        ],
        thinkingLevel: "off",
        model: null,
      }),
      getSessionId: () => "sess-1",
    },
    modelRegistry: {
      find: () => config?.foundModel,
      complete: async (model: any, context: any, options: any) => {
        calls.complete.push({ model, context, options })
        // Mimic pi-ai: hand the assembled params to onPayload before sending.
        if (typeof options?.onPayload === "function") {
          await options.onPayload({
            model: model?.id ?? "m",
            stream: true,
            tools: [{ type: "function", function: { name: "read" } }],
            messages: context.messages,
          })
        }
        // ...and the response headers to onResponse once "the wire" answers.
        if (typeof options?.onResponse === "function") {
          await options.onResponse(
            { status: 200, headers: { "x-replica": "mock-1", "set-cookie": "session=secret" } },
            model,
          )
        }
        return respond()
      },
    },
  } as unknown as ExtensionContext

  cacheCompact(api)
  const handler = handlers.get("session_before_compact")!
  const providerHandler = handlers.get("before_provider_request")!
  return { handler, providerHandler, ctx, calls, handlers }
}

function event(overrides: Partial<SessionBeforeCompactEvent> = {}): SessionBeforeCompactEvent {
  return {
    type: "session_before_compact",
    preparation: { firstKeptEntryId: "keep-1", tokensBefore: 1234 } as any,
    branchEntries: [],
    customInstructions: undefined,
    reason: "threshold",
    willRetry: false,
    signal: new AbortController().signal,
    ...overrides,
  }
}

function tempWorkspace(config?: unknown): { cwd: string; agentDir: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cache-compact-ext-"))
  const cwd = path.join(root, "project")
  const agentDir = path.join(root, "agent")
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true })
  fs.mkdirSync(agentDir, { recursive: true })
  if (config) fs.writeFileSync(path.join(cwd, ".pi", "cache-compact.json"), JSON.stringify(config))
  return { cwd, agentDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test("writes a summary as a forward continuation of the live conversation", async () => {
  const ws = tempWorkspace()
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, ctx, calls } = setup({ cwd: ws.cwd })
    const result = (await handler(event(), ctx)) as any

    assert.equal(result.compaction.summary, "MOCK SUMMARY")
    assert.equal(result.compaction.firstKeptEntryId, "keep-1")
    assert.equal(result.compaction.tokensBefore, 1234)
    assert.equal(result.compaction.usage.cacheRead, 5)

    assert.equal(calls.complete.length, 1)
    const { context, options } = calls.complete[0]
    // The projection's leading system message is reused as-is, so no synthetic
    // prompt/tools and no doubled system message.
    assert.equal(context.systemPrompt, "")
    assert.deepEqual(context.tools, [])
    // The whole live message list (system, user, assistant, kept tail) + ask:
    // the request must be a forward continuation of the live request the server
    // has cached, not a rewind to the dropped span. Measured on llama.cpp, a
    // request 35 tokens shorter than the checkpoint re-prefilled all 7710
    // tokens, while a continuation reused 7706/7745 in 0.4 s.
    assert.equal(context.messages.length, 5)
    assert.equal(context.messages[0].role, "system")
    assert.equal(context.messages[1].content, "hello from the session")
    assert.equal(context.messages.at(-2).content, "recent kept message")
    assert.equal(context.messages.at(-1).role, "user")
    const askText = context.messages.at(-1).content[0].text
    assert.match(askText, /structured context checkpoint summary/i)
    // ...but the kept tail must stay out of the summary *text*, or the summary
    // would describe messages that Pi keeps verbatim a second time.
    assert.match(askText, /1 later message\(s\) stay in the context verbatim/)
    assert.match(askText, /assistant message that begins/)
    assert.match(askText, /"hi"/)
    assert.equal(options.toolChoice, "none")
    assert.equal(options.cacheRetention, "short")
  } finally {
    ws.cleanup()
  }
})

test("continuation: false sends the dropped span only", async () => {
  const ws = tempWorkspace({ continuation: false })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, ctx, calls } = setup({ cwd: ws.cwd })
    await handler(event(), ctx)

    const { context } = calls.complete[0]
    // The old shape: dropped span (system, user, assistant) + ask, so the kept
    // tail is not resent. Correct summaries, but a cache rewind on an
    // append-only server.
    assert.equal(context.messages.length, 4)
    assert.ok(
      !context.messages.some((message: any) => message.content === "recent kept message"),
      "the kept tail must not be resent with continuation: false",
    )
    const askText = context.messages.at(-1).content[0].text
    // Nothing in the request is outside the summary's scope, so no boundary note.
    assert.doesNotMatch(askText, /stay in the context verbatim/)
  } finally {
    ws.cleanup()
  }
})


test("a continuation that would not fit defers to Pi instead of rewinding", async () => {
  const debugFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-rewind-")), "debug.jsonl")
  const ws = tempWorkspace({ debug: true, debugFile })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    // Small dropped span, huge kept tail: no continuation fits. The rewind is
    // the only option left and has never reused a cache, so Pi's small summary
    // is the cheaper choice.
    const huge = "x".repeat(200_000)
    const { handler, ctx, calls } = setup({
      cwd: ws.cwd,
      model: { provider: "mock", id: "test-model", contextWindow: 32_000 },
      messages: [
        { role: "system", content: "SYSTEM PROMPT", timestamp: 0 },
        { role: "user", content: "hello from the session", timestamp: 1 },
        { role: "user", content: huge, timestamp: 3 },
      ],
      entries: [
        { sourceEntry: { id: "sys" }, messages: [{ role: "system", content: "SYSTEM PROMPT", timestamp: 0 }] },
        { sourceEntry: { id: "u1" }, messages: [{ role: "user", content: "hello from the session", timestamp: 1 }] },
        { sourceEntry: { id: "keep-1" }, messages: [{ role: "user", content: huge, timestamp: 3 }] },
      ],
    })
    assert.equal(await handler(event(), ctx), undefined)
    assert.equal(calls.complete.length, 0, "sent the rewinding shape instead of deferring")
    assert.ok(
      readRecords(debugFile).some((r) => /only the rewinding shape fits/.test(r.kind)),
      "no deferral record",
    )
  } finally {
    ws.cleanup()
  }
})

test("rewindWhenNeeded: true sends the dropped span when nothing else fits", async () => {
  const ws = tempWorkspace({ rewindWhenNeeded: true })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const huge = "x".repeat(200_000)
    const { handler, ctx, calls } = setup({
      cwd: ws.cwd,
      model: { provider: "mock", id: "test-model", contextWindow: 32_000 },
      messages: [
        { role: "system", content: "SYSTEM PROMPT", timestamp: 0 },
        { role: "user", content: "hello from the session", timestamp: 1 },
        { role: "user", content: huge, timestamp: 3 },
      ],
      entries: [
        { sourceEntry: { id: "sys" }, messages: [{ role: "system", content: "SYSTEM PROMPT", timestamp: 0 }] },
        { sourceEntry: { id: "u1" }, messages: [{ role: "user", content: "hello from the session", timestamp: 1 }] },
        { sourceEntry: { id: "keep-1" }, messages: [{ role: "user", content: huge, timestamp: 3 }] },
      ],
    })
    await handler(event(), ctx)
    // Dropped span (system, user) + ask, with the oversized tail left out.
    assert.equal(calls.complete.length, 1)
    assert.equal(calls.complete[0].context.messages.length, 3)
    assert.ok(!calls.complete[0].context.messages.some((m: any) => m.content === huge))
  } finally {
    ws.cleanup()
  }
})

test("rejects unusable summaries and leaves compaction to Pi", async () => {
  const cases: Array<[AssistantMessage, RegExp]> = [
    [assistant([{ type: "text", text: "  " }]), /no summary text/],
    [assistant([{ type: "text", text: "partial" }], "length"), /token cap/],
    [assistant([{ type: "toolCall", id: "1", name: "read", arguments: {} }] as any, "toolUse"), /call a tool/],
  ]
  for (const [response] of cases) {
    const ws = tempWorkspace()
    process.env.PI_CODING_AGENT_DIR = ws.agentDir
    try {
      const { handler, ctx } = setup({ cwd: ws.cwd, response })
      assert.equal(await handler(event(), ctx), undefined)
    } finally {
      ws.cleanup()
    }
  }
})

test("falls back to Pi's default when the summary request throws", async () => {
  const ws = tempWorkspace()
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, ctx } = setup({
      cwd: ws.cwd,
      response: async () => {
        throw new Error("connection refused")
      },
    })
    assert.equal(await handler(event(), ctx), undefined)
  } finally {
    ws.cleanup()
  }
})

test("ignores sessions whose model is not listed", async () => {
  const ws = tempWorkspace({ models: ["other/model"] })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, ctx, calls } = setup({ cwd: ws.cwd })
    assert.equal(await handler(event(), ctx), undefined)
    assert.equal(calls.complete.length, 0)
  } finally {
    ws.cleanup()
  }
})

test("honours a custom prompt, a summarizer model, and custom instructions", async () => {
  const ws = tempWorkspace({
    summaryModel: { provider: "mock", id: "small" },
    summaryPrompt: "CUSTOM HANDOFF",
    summaryMaxTokens: 321,
  })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const small = { provider: "mock", id: "small" }
    const { handler, ctx, calls } = setup({ cwd: ws.cwd, foundModel: small })
    await handler(event({ customInstructions: "focus on the tests" }), ctx)

    assert.equal(calls.complete[0].model, small)
    assert.equal(calls.complete[0].options.maxTokens, 321)
    // Unset summaryReasoningEffort must leave the server's default effort
    // untouched — sending null/undefined explicitly would change the request.
    assert.equal("reasoningEffort" in calls.complete[0].options, false)
    const askText = calls.complete[0].context.messages.at(-1).content[0].text
    assert.ok(askText.startsWith("CUSTOM HANDOFF\n\nDo not call any tools."))
    assert.match(askText, /Additional focus: focus on the tests/)
    // The boundary note is appended after the custom text, not instead of it.
    assert.match(askText, /stay in the context verbatim/)
  } finally {
    ws.cleanup()
  }
})

test("forwards summaryReasoningEffort and derives the summary ceiling", async () => {
  const ws = tempWorkspace({ summaryReasoningEffort: "minimal" })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, ctx, calls } = setup({ cwd: ws.cwd })
    await handler(event(), ctx)

    assert.equal(calls.complete.length, 1)
    assert.equal(calls.complete[0].options.reasoningEffort, "minimal")
    // Derived, not constant: Pi's 0.8 x reserveTokens (13,107) bounded by half
    // of what this compaction drops — a tiny fixture, so the reclaimed bound
    // (floored at 2048) wins.
    assert.equal(calls.complete[0].options.maxTokens, 2048)
  } finally {
    ws.cleanup()
  }
})

test("summary ask mirrors the last live reasoning effort, following mid-session changes", async () => {
  const ws = tempWorkspace()
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, providerHandler, ctx, calls } = setup({ cwd: ws.cwd })

    providerHandler({ type: "before_provider_request", payload: { model: "m", reasoning_effort: "high" } }, ctx)
    await handler(event(), ctx)
    assert.equal(calls.complete[0].options.reasoningEffort, "high")

    // /thinking changed after the last observed live request: the cached
    // prefix is keyed by the newest live payload, so the next ask follows it.
    providerHandler({ type: "before_provider_request", payload: { model: "m", reasoning_effort: "minimal" } }, ctx)
    await handler(event(), ctx)
    assert.equal(calls.complete[1].options.reasoningEffort, "minimal")
  } finally {
    ws.cleanup()
  }
})

test("omits effort when live requests omit it; config overrides observation", async () => {
  const withOverride = tempWorkspace({ summaryReasoningEffort: "low" })
  const plain = tempWorkspace()
  try {
    // Live omits the effort -> the ask must omit it too (third cache variant).
    process.env.PI_CODING_AGENT_DIR = plain.agentDir
    {
      const { handler, providerHandler, ctx, calls } = setup({ cwd: plain.cwd })
      providerHandler({ type: "before_provider_request", payload: { model: "m" } }, ctx)
      await handler(event(), ctx)
      assert.equal("reasoningEffort" in calls.complete[0].options, false)
    }
    // Explicit config wins over whatever is on the wire.
    process.env.PI_CODING_AGENT_DIR = withOverride.agentDir
    {
      const { handler, providerHandler, ctx, calls } = setup({ cwd: withOverride.cwd })
      providerHandler({ type: "before_provider_request", payload: { model: "m", reasoning_effort: "high" } }, ctx)
      await handler(event(), ctx)
      assert.equal(calls.complete[0].options.reasoningEffort, "low")
    }
  } finally {
    withOverride.cleanup()
    plain.cleanup()
  }
})

test("runs the default summary when disabled", async () => {
  const ws = tempWorkspace({ enabled: false })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, ctx, calls } = setup({ cwd: ws.cwd })
    assert.equal(await handler(event(), ctx), undefined)
    assert.equal(calls.complete.length, 0)
  } finally {
    ws.cleanup()
  }
})

function readRecords(file: string): any[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test("debug records the compaction lifecycle to debugFile", async () => {
  const debugFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-dbg-")), "debug.jsonl")
  const ws = tempWorkspace({ debug: true, debugFile })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, ctx } = setup({ cwd: ws.cwd })
    await handler(event(), ctx)

    const records = readRecords(debugFile)
    const start = records.find((r) => r.kind === "summary_start")
    const result = records.find((r) => r.kind === "summary_result")
    assert.ok(start, "no summary_start record")
    assert.equal(start.sessionId, "sess-1")
    assert.equal(start.askHash.length, 12)
    assert.equal(start.tokensBefore, 1234)
    assert.ok(result, "no summary_result record")
    assert.equal(result.chars, "MOCK SUMMARY".length)
    assert.equal(result.cacheRead, 5)
    assert.equal(typeof result.durationMs, "number")
  } finally {
    ws.cleanup()
  }
})

test("provider requests are fingerprinted and the in-flight summary is tagged", async () => {
  const debugFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-dbg-")), "debug.jsonl")
  const ws = tempWorkspace({ debug: true, debugFile })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    // While the summarization request is in flight, replay a provider hook
    // with a payload whose last message is the ask — it must be tagged.
    const { handler, providerHandler, ctx, calls } = setup({
      cwd: ws.cwd,
      response: async () => {
        const askText = calls.complete[0].context.messages.at(-1).content[0].text
        // A live-looking request: must not be tagged.
        providerHandler(
          { type: "before_provider_request", payload: { model: "m", messages: [{ role: "user", content: "hi" }] } },
          ctx,
        )
        // Our summarization request: last user message is the ask.
        providerHandler(
          {
            type: "before_provider_request",
            payload: {
              model: "m",
              tools: [{ type: "function", function: { name: "read" } }],
              messages: [
                { role: "system", content: "SYSTEM PROMPT" },
                { role: "user", content: [{ type: "text", text: askText }] },
              ],
            },
          },
          ctx,
        )
        return {
          role: "assistant",
          content: [{ type: "text", text: "MOCK SUMMARY" }],
          api: "openai-completions",
          provider: "mock",
          model: "test-model",
          usage: { input: 1, output: 1, cacheRead: 5, cacheWrite: 0, totalTokens: 2, cost: {} },
          stopReason: "stop",
          timestamp: Date.now(),
        } as any
      },
    })
    await handler(event(), ctx)

    const providerRecords = readRecords(debugFile).filter((r) => r.kind === "provider_request")
    // Three: the extension's own summary record (written via the mock's
    // onPayload callback), plus the two payloads replayed through the hook
    // from the response callback: a live-looking one and the ask-bearing one.
    assert.equal(providerRecords.length, 3)
    const live = providerRecords.find((r) => r.summary === undefined)
    const own = providerRecords.find((r) => r.summary === true && r.systemSource !== undefined)
    const tagged = providerRecords.find((r) => r.summary === true && r.systemSource === undefined)
    assert.ok(live && own && tagged, `expected one live, one own, one tagged record:\n${JSON.stringify(providerRecords, null, 1)}`)
    assert.equal(live.pendingSummary, true)
    assert.equal(live.messageCount, 1)
    assert.equal(tagged.toolsCount, 1)
    assert.equal(tagged.rolling.length, 2, "the two-message ask payload must be tagged summary=true")
    assert.ok(own.rolling.length > 2, "the extension's own request comes from onPayload")

  } finally {
    ws.cleanup()
  }
})

test("provider handler stays silent and never throws without debug", () => {
  const ws = tempWorkspace()
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { providerHandler, ctx } = setup({ cwd: ws.cwd })
    assert.doesNotThrow(() => providerHandler({ type: "before_provider_request", payload: undefined }, ctx))
    assert.doesNotThrow(() => providerHandler({ type: "before_provider_request", payload: { messages: [{}] } }, ctx))
  } finally {
    ws.cleanup()
  }
})

test("debugPayloads dumps live_before, summarization, and live_after", async () => {
  const debugFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-dump-")), "debug.jsonl")
  const ws = tempWorkspace({ debug: true, debugFile, debugPayloads: true })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, providerHandler, ctx } = setup({ cwd: ws.cwd })

    // A live request before compaction.
    providerHandler(
      {
        type: "before_provider_request",
        payload: {
          model: "m",
          messages: [
            { role: "system", content: "SYSTEM PROMPT" },
            { role: "user", content: "hello from the session" },
          ],
        },
      },
      ctx,
    )
    await handler(event(), ctx)
    // First live request after compaction.
    providerHandler(
      {
        type: "before_provider_request",
        payload: { model: "m", messages: [{ role: "system", content: "SYSTEM PROMPT" }] },
      },
      ctx,
    )

    const dumps = readRecords(debugFile).filter((r) => r.kind === "payload_dump")
    const byVariant = Object.fromEntries(dumps.map((r) => [r.variant, r]))
    assert.deepEqual(Object.keys(byVariant).sort(), ["live_after", "live_before", "summarization"])
    assert.equal(byVariant.live_before.payload.messages.length, 2)
    assert.equal(byVariant.live_after.payload.messages.length, 1)
    // The mock projection starts with a recorded system message.
    assert.equal(byVariant.summarization.systemSource, "recorded")
    const summaryMessages = byVariant.summarization.payload.messages
    assert.match(summaryMessages.at(-1).content[0].text, /summary/i)

    // The compare script runs against the dump and finds a shared prefix.
    const { execFileSync } = await import("node:child_process")
    const script = new URL("../scripts/compare-dumps.mjs", import.meta.url).pathname
    let out = ""
    try {
      out = execFileSync("node", [script, debugFile], { encoding: "utf8" })
    } catch (error: any) {
      out = String(error.stdout ?? "") // exit 1 = divergence found, still prints
    }
    assert.match(out, /shared prefix=\d+/)
    assert.match(out, /byte-identical prefix|diverge/)
  } finally {
    ws.cleanup()
  }
})

test("no payload dumps without debugPayloads", async () => {
  const debugFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-dump-")), "debug.jsonl")
  const ws = tempWorkspace({ debug: true, debugFile })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, providerHandler, ctx } = setup({ cwd: ws.cwd })
    providerHandler({ type: "before_provider_request", payload: { messages: [{ role: "user", content: "x" }] } }, ctx)
    await handler(event(), ctx)
    const kinds = readRecords(debugFile).map((r) => r.kind)
    assert.ok(!kinds.includes("payload_dump"))
    assert.ok(kinds.includes("summary_result"))
  } finally {
    ws.cleanup()
  }
})

test("summary ask replays captured live request headers", async () => {
  const ws = tempWorkspace()
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, handlers, ctx, calls } = setup({ cwd: ws.cwd })
    handlers.get("before_provider_headers")!(
      {
        type: "before_provider_headers",
        headers: {
          "x-session-affinity": "aff-123",
          "user-agent": "pi/1.2.3",
          "content-length": "99999",
          connection: "keep-alive",
          "x-deleted": null,
        },
      },
      ctx,
    )
    await handler(event(), ctx)

    assert.equal(calls.complete.length, 1)
    assert.deepEqual(calls.complete[0].options.headers, {
      "x-session-affinity": "aff-123",
      "user-agent": "pi/1.2.3",
    })
  } finally {
    ws.cleanup()
  }
})

test("no headers option when no live request was observed", async () => {
  const ws = tempWorkspace()
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, ctx, calls } = setup({ cwd: ws.cwd })
    await handler(event(), ctx)
    assert.equal("headers" in calls.complete[0].options, false)
  } finally {
    ws.cleanup()
  }
})

test("debug logs live and summary headers and response headers, redacted", async () => {
  const debugFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-hdr-")), "debug.jsonl")
  const ws = tempWorkspace({ debug: true, debugFile })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, handlers, ctx, calls } = setup({ cwd: ws.cwd })
    handlers.get("before_provider_headers")!(
      { type: "before_provider_headers", headers: { authorization: "Bearer supersecret", "x-replica-pin": "r7" } },
      ctx,
    )
    handlers.get("after_provider_response")!({ type: "after_provider_response", status: 200, headers: { "x-replica": "r7", "set-cookie": "s=1" } }, ctx)
    await handler(event(), ctx)

    const records = readRecords(debugFile)
    const headerRecords = records.filter((r) => r.kind === "provider_headers")
    const responseRecords = records.filter((r) => r.kind === "provider_response")

    const liveHeaders = headerRecords.find((r) => r.summary === false)
    assert.equal(liveHeaders.headers["x-replica-pin"], "r7")
    assert.equal(liveHeaders.headers.authorization, "[redacted]")

    const liveResponse = responseRecords.find((r) => r.summary === false)
    assert.equal(liveResponse.status, 200)
    assert.equal(liveResponse.headers["x-replica"], "r7")
    assert.equal(liveResponse.headers["set-cookie"], "[redacted]")

    const summaryHeaders = headerRecords.find((r) => r.summary === true)
    assert.equal(summaryHeaders.liveCaptured, true)
    // authorization is replayed but logged redacted.
    assert.equal(summaryHeaders.headers.authorization, "[redacted]")
    assert.equal(summaryHeaders.headers["x-replica-pin"], "r7")

    // The mock complete() answers via onResponse; that must land as a record.
    const summaryResponse = responseRecords.find((r) => r.summary === true)
    assert.equal(summaryResponse.status, 200)
    assert.equal(summaryResponse.headers["x-replica"], "mock-1")
    assert.equal(summaryResponse.headers["set-cookie"], "[redacted]")
  } finally {
    ws.cleanup()
  }
})

test("header handlers never throw on junk", () => {
  const ws = tempWorkspace()
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handlers, ctx } = setup({ cwd: ws.cwd })
    assert.doesNotThrow(() => handlers.get("before_provider_headers")!({ type: "before_provider_headers", headers: undefined }, ctx))
    assert.doesNotThrow(() => handlers.get("after_provider_response")!({ type: "after_provider_response", status: 500, headers: undefined }, ctx))
  } finally {
    ws.cleanup()
  }
})

test("continues the last live request when a trailing tool result is huge", async () => {
  const ws = tempWorkspace()
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    // Production shape: Pi compacts *because* a big tool result arrived, so the
    // projection no longer fits — but the request the server has cached still
    // does, and appending the ask to it stays a forward continuation.
    const huge = "x".repeat(200_000)
    const { handler, providerHandler, ctx, calls } = setup({
      cwd: ws.cwd,
      model: { provider: "mock", id: "test-model", contextWindow: 32_000 },
      messages: [
        { role: "system", content: "SYSTEM PROMPT", timestamp: 0 },
        { role: "user", content: "hello from the session", timestamp: 1 },
        { role: "user", content: "recent kept message", timestamp: 3 },
        { role: "toolResult", content: huge, timestamp: 4 },
      ],
      entries: [
        { sourceEntry: { id: "sys" }, messages: [{ role: "system", content: "SYSTEM PROMPT", timestamp: 0 }] },
        { sourceEntry: { id: "u1" }, messages: [{ role: "user", content: "hello from the session", timestamp: 1 }] },
        { sourceEntry: { id: "keep-1" }, messages: [{ role: "user", content: "recent kept message", timestamp: 3 }] },
        { sourceEntry: { id: "tr1" }, messages: [{ role: "toolResult", content: huge, timestamp: 4 }] },
      ],
    })
    // The last live request carried the first three messages.
    providerHandler(
      {
        type: "before_provider_request",
        payload: {
          model: "m",
          messages: [
            { role: "system", content: "SYSTEM PROMPT" },
            { role: "user", content: "hello from the session" },
            { role: "user", content: "recent kept message" },
          ],
        },
      },
      ctx,
    )
    await handler(event(), ctx)

    const { context } = calls.complete[0]
    // system + user + kept message + ask: exactly the cached request plus the ask.
    assert.equal(context.messages.length, 4)
    assert.equal(context.messages.at(-2).content, "recent kept message")
    assert.ok(
      !context.messages.some((message: any) => message.content === huge),
      "the oversized tool result must be left out of the request",
    )
  } finally {
    ws.cleanup()
  }
})

test("retries once when the reply stopped with no text, then gives up", async () => {
  const debugFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-retry-")), "debug.jsonl")
  const ws = tempWorkspace({ debug: true, debugFile })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    // First attempt: thinking only, no text (the production failure). Second:
    // a proper summary, so the retry is what saves the compaction.
    let attempt = 0
    const { handler, ctx, calls } = setup({
      cwd: ws.cwd,
      response: async () => {
        attempt++
        return attempt === 1
          ? assistant([{ type: "thinking", thinking: "let me plan the summary" }] as any)
          : assistant([{ type: "text", text: "RETRIED SUMMARY" }])
      },
    })
    const result = (await handler(event(), ctx)) as any
    assert.equal(calls.complete.length, 2)
    assert.equal(result.compaction.summary, "RETRIED SUMMARY")

    // The retry keeps the same prefix and only nudges the end of the ask, so the
    // cache still covers everything before the ask.
    const first = calls.complete[0].context.messages
    const second = calls.complete[1].context.messages
    assert.deepEqual(second.slice(0, -1), first.slice(0, -1))
    assert.ok(second.at(-1).content[0].text.startsWith(first.at(-1).content[0].text))
    assert.match(second.at(-1).content[0].text, /Reminder: reply with the summary text itself/)

    // The retry is recorded, with the reason it was attempted (the first reply's
    // shape) and its own outcome.
    const retry = readRecords(debugFile).find((r) => r.kind === "summary_retry")
    assert.ok(retry, `no summary_retry record`)
    assert.equal(retry.reason, undefined, `retry did not succeed`)
    assert.equal(retry.stopReason, "stop")
  } finally {
    ws.cleanup()
  }
})

test("does not retry failures that would repeat (token cap, tool call, abort)", async () => {
  for (const [response, pattern] of [
    [assistant([{ type: "text", text: "partial" }], "length"), /token cap/],
    [assistant([{ type: "toolCall", id: "1", name: "read", arguments: {} }] as any, "toolUse"), /call a tool/],
    [assistant([{ type: "text", text: "x" }], "aborted"), /aborted/],
  ] as const) {
    const ws = tempWorkspace()
    process.env.PI_CODING_AGENT_DIR = ws.agentDir
    try {
      const { handler, ctx, calls } = setup({ cwd: ws.cwd, response })
      assert.equal(await handler(event(), ctx), undefined)
      assert.equal(calls.complete.length, 1, `retried a ${pattern} failure`)
    } finally {
      ws.cleanup()
    }
  }
})

test("an empty reply retried into another empty reply falls back to Pi", async () => {
  const ws = tempWorkspace()
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, ctx, calls } = setup({
      cwd: ws.cwd,
      response: async () => assistant([{ type: "thinking", thinking: "still deliberating" }] as any),
    })
    assert.equal(await handler(event(), ctx), undefined)
    assert.equal(calls.complete.length, 2)
  } finally {
    ws.cleanup()
  }
})

function withUsage(usage: Record<string, number> & { content?: any[] }): any {
  const { content, ...rest } = usage
  return {
    role: "assistant",
    content: content ?? [{ type: "text", text: "MOCK SUMMARY" }],
    api: "openai-completions",
    provider: "mock",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {}, ...rest },
    stopReason: "stop",
    timestamp: Date.now(),
  }
}

test("a continuation that missed the cache defers the next compaction to Pi", async () => {
  const debugFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-defer-")), "debug.jsonl")
  const ws = tempWorkspace({ debug: true, debugFile })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    // A cold read of a large prompt: the server no longer holds the conversation.
    const { handler, ctx, calls } = setup({
      cwd: ws.cwd,
      response: async () => withUsage({ input: 100_000, output: 500, cacheRead: 0 }),
    })
    const first = (await handler(event(), ctx)) as any
    assert.equal(first.compaction.summary, "MOCK SUMMARY")
    assert.equal(calls.complete.length, 1)

    // The next compaction would pay the same full prefill, so Pi's small
    // truncated summary is the cheaper option.
    assert.equal(await handler(event(), ctx), undefined)
    assert.equal(calls.complete.length, 1, "the continuation was attempted again after a miss")
    assert.ok(
      readRecords(debugFile).some((r) => /missed the cache/.test(r.kind)),
      "no deferral record",
    )
  } finally {
    ws.cleanup()
  }
})

test("a continuation that hit the cache keeps being used", async () => {
  const ws = tempWorkspace()
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, ctx, calls } = setup({
      cwd: ws.cwd,
      response: async () => withUsage({ input: 120, output: 500, cacheRead: 108_000 }),
    })
    await handler(event(), ctx)
    await handler(event(), ctx)
    assert.equal(calls.complete.length, 2, "a cache hit must not disable the continuation")
  } finally {
    ws.cleanup()
  }
})

test("a miss is cheap to ignore when the prompt was small", async () => {
  const ws = tempWorkspace()
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, ctx, calls } = setup({
      cwd: ws.cwd,
      response: async () => withUsage({ input: 800, output: 100, cacheRead: 0 }),
    })
    await handler(event(), ctx)
    await handler(event(), ctx)
    assert.equal(calls.complete.length, 2, "a small miss should not disable the continuation")
  } finally {
    ws.cleanup()
  }
})

test("deferAfterCacheMiss: false always tries the continuation", async () => {
  const ws = tempWorkspace({ deferAfterCacheMiss: false })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, ctx, calls } = setup({
      cwd: ws.cwd,
      response: async () => withUsage({ input: 100_000, output: 500, cacheRead: 0 }),
    })
    await handler(event(), ctx)
    await handler(event(), ctx)
    assert.equal(calls.complete.length, 2)
  } finally {
    ws.cleanup()
  }
})

test("the persisted summary carries Pi's file appendix and details", async () => {
  const ws = tempWorkspace()
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, ctx } = setup({ cwd: ws.cwd })
    const result = (await handler(
      event({
        preparation: {
          firstKeptEntryId: "keep-1",
          tokensBefore: 1234,
          turnPrefixMessages: [],
          fileOps: {
            read: new Set(["read.ts"]),
            written: new Set(["new.ts"]),
            edited: new Set(["edited.ts"]),
          },
        } as any,
      }),
      ctx,
    )) as any

    assert.deepEqual(result.compaction.details, {
      readFiles: ["read.ts"],
      modifiedFiles: ["edited.ts", "new.ts"],
    })
    assert.match(
      result.compaction.summary,
      /MOCK SUMMARY\n\n<read-files>\nread\.ts\n<\/read-files>\n\n<modified-files>\nedited\.ts\nnew\.ts\n<\/modified-files>$/,
    )
  } finally {
    ws.cleanup()
  }
})

test("a split turn asks for Pi's two-part artifact", async () => {
  const ws = tempWorkspace()
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, ctx, calls } = setup({ cwd: ws.cwd })
    await handler(
      event({
        preparation: {
          firstKeptEntryId: "keep-1",
          tokensBefore: 1234,
          turnPrefixMessages: [{ role: "user", content: "the turn that got cut" }],
        } as any,
      }),
      ctx,
    )
    const askText = calls.complete[0].context.messages.at(-1).content[0].text
    assert.match(askText, /\*\*Turn Context \(split turn\):\*\*/)
    assert.match(askText, /^## Original Request$/m)
    // Still a continuation: the request carries the live messages plus the ask.
    assert.equal(calls.complete[0].context.messages.length, 5)
  } finally {
    ws.cleanup()
  }
})

test("no retry when the first attempt missed the cache (a retry would re-prefill)", async () => {
  const ws = tempWorkspace()
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    // Empty reply *and* a cold read of a large prompt: retrying would pay the
    // full prefill again, so the extension hands over to Pi instead.
    const { handler, ctx, calls } = setup({
      cwd: ws.cwd,
      response: async () =>
        withUsage({
          input: 100_000,
          output: 5,
          cacheRead: 0,
          content: [{ type: "thinking", thinking: "deliberating" }],
        } as any),
    })
    assert.equal(await handler(event(), ctx), undefined)
    assert.equal(calls.complete.length, 1, "retried despite a cold cache")
  } finally {
    ws.cleanup()
  }
})
