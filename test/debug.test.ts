import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  DebugLogger,
  fingerprintPayload,
  snapshot,
  rollingMessageHashes,
  sharedPrefixLength,
  shortHash,
  redactHeaders,
} from "../src/debug.ts"

test("shortHash is stable and value-sensitive", () => {
  assert.equal(shortHash({ a: 1 }), shortHash({ a: 1 }))
  assert.notEqual(shortHash({ a: 1 }), shortHash({ a: 2 }))
  // Key order is part of the value, like the wire serializer.
  assert.notEqual(shortHash({ a: 1, b: 2 }), shortHash({ b: 2, a: 1 }))
  assert.doesNotThrow(() => shortHash(undefined))
  const circular: any = {}
  circular.self = circular
  assert.doesNotThrow(() => shortHash(circular))
})

test("snapshot detaches from later mutation", () => {
  const value: any = { messages: [{ role: "user", content: "hi" }] }
  const snap = snapshot(value) as any
  value.messages[0].content = "mutated"
  assert.equal(snap.messages[0].content, "hi")
  const circular: any = {}
  circular.self = circular
  assert.equal(typeof snapshot(circular), "string")
})

test("rolling hashes mark exactly the divergence index", () => {
  const a = [{ role: "system" }, { role: "user" }, { role: "assistant" }]
  const b = [{ role: "system" }, { role: "user", content: "changed" }, { role: "assistant" }]
  const ra = rollingMessageHashes(a)
  const rb = rollingMessageHashes(b)
  assert.equal(sharedPrefixLength(ra, ra), 3)
  assert.equal(sharedPrefixLength(ra, rb), 1)
  // A longer list sharing the prefix still reports the shorter length.
  assert.equal(sharedPrefixLength(ra, [...rollingMessageHashes(a), "x"]), 3)
})

test("fingerprintPayload captures the OpenAI-style request shape", () => {
  const fp = fingerprintPayload({
    model: "m",
    stream: true,
    tool_choice: "none",
    tools: [{ type: "function", function: { name: "read" } }],
    messages: [
      { role: "system", content: "prompt" },
      { role: "user", content: [{ type: "text", text: "ask" }] },
    ],
  } as any)
  assert.equal(fp.model, "m")
  assert.equal(fp.stream, true)
  assert.equal(fp.toolChoice, "none")
  assert.equal(fp.toolsCount, 1)
  assert.equal(fp.messageCount, 2)
  assert.equal(fp.lastMessageRole, "user")
  assert.equal(fp.lastMessageTextHash, shortHash("ask"))
  assert.deepEqual((fp.rolling as string[]).length, 2)
})

test("fingerprintPayload survives junk", () => {
  for (const junk of [undefined, null, "string", 42, {}, { messages: "no" }]) {
    assert.doesNotThrow(() => fingerprintPayload(junk))
  }
})

test("DebugLogger appends JSONL only when enabled with a file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-compact-debug-"))
  const file = path.join(dir, "debug.jsonl")
  try {
    new DebugLogger(false, file).record("k", { a: 1 })
    assert.equal(fs.existsSync(file), false)

    new DebugLogger(true).record("k", { a: 1 }) // no file: silently dropped

    const logger = new DebugLogger(true, file)
    logger.record("first", { a: 1 })
    logger.record("second", { b: "two" })
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as any)
    assert.equal(lines.length, 2)
    assert.equal(lines[0].kind, "first")
    assert.equal(lines[0].a, 1)
    assert.ok(lines[0].ts)
    assert.equal(lines[1].kind, "second")

    // Unwritable file must not throw.
    assert.doesNotThrow(() => new DebugLogger(true, path.join(dir, "nope", "x.jsonl")).record("k"))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("redactHeaders hides secrets but keeps header names visible", () => {
  const out = redactHeaders({
    Authorization: "Bearer supersecret",
    "proxy-authorization": "Basic abc",
    "x-api-key": "sk-123",
    "Set-Cookie": "session=secret",
    cookie: "a=b",
    "x-session-affinity": "aff-123",
    "user-agent": "pi/1.2.3",
    "x-null-deleted": null,
  })
  assert.deepEqual(out, {
    Authorization: "[redacted]",
    "proxy-authorization": "[redacted]",
    "x-api-key": "[redacted]",
    "Set-Cookie": "[redacted]",
    cookie: "[redacted]",
    "x-session-affinity": "aff-123",
    "user-agent": "pi/1.2.3",
    "x-null-deleted": "null",
  })
  assert.deepEqual(redactHeaders(undefined), {})
  assert.deepEqual(redactHeaders(null), {})
})
