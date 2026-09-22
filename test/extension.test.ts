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
  model?: { provider: string; id: string }
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
        return respond()
      },
    },
  } as unknown as ExtensionContext

  cacheCompact(api)
  const handler = handlers.get("session_before_compact")!
  return { handler, ctx, calls }
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

test("writes a summary as a continuation of the live conversation", async () => {
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
    // Dropped span (system, user, assistant) + the ask; the kept tail is absent.
    assert.equal(context.messages.length, 4)
    assert.equal(context.messages[0].role, "system")
    assert.equal(context.messages[1].content, "hello from the session")
    assert.equal(context.messages.at(-1).role, "user")
    assert.match(context.messages.at(-1).content[0].text, /handoff summary/i)
    assert.ok(
      !context.messages.some((message: any) => message.content === "recent kept message"),
      "the kept tail must not be resent for summarization",
    )
    assert.equal(options.toolChoice, "none")
    assert.equal(options.cacheRetention, "short")
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
    assert.equal(
      calls.complete[0].context.messages.at(-1).content[0].text,
      "CUSTOM HANDOFF\n\nAdditional focus: focus on the tests",
    )
  } finally {
    ws.cleanup()
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
