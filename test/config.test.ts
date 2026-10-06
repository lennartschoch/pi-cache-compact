import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { parseOptions, readOptions } from "../src/config.ts"

test("parseOptions keeps valid fields and drops unknown or wrongly typed ones", () => {
  assert.deepEqual(
    parseOptions({
      enabled: false,
      models: ["mock/test-model", 42],
      summaryModel: { provider: "mock", id: "small" },
      summaryPrompt: "  do it  ",
      summaryMaxTokens: 512.9,
      summaryReasoningEffort: "minimal",
      cacheRetention: "long",
      toolChoice: "none",
      debug: true,
      debugFile: "  /tmp/cc.jsonl  ",
      debugPayloads: true,
      nonsense: "ignored",
    }),
    {
      enabled: false,
      models: ["mock/test-model"],
      summaryModel: { provider: "mock", id: "small" },
      summaryPrompt: "  do it  ",
      summaryMaxTokens: 512,
      summaryReasoningEffort: "minimal",
      cacheRetention: "long",
      toolChoice: "none",
      debug: true,
      debugFile: "/tmp/cc.jsonl",
      debugPayloads: true,
    },
  )
})

test("parseOptions rejects malformed values without throwing", () => {
  assert.deepEqual(parseOptions(null), {})
  assert.deepEqual(parseOptions("nope"), {})
  assert.deepEqual(parseOptions({ models: [], summaryMaxTokens: -3, cacheRetention: "forever" }), {})
  assert.deepEqual(parseOptions({ summaryReasoningEffort: "none" }), { summaryReasoningEffort: "none" })
  assert.deepEqual(parseOptions({ summaryReasoningEffort: 42 }), {})
  assert.deepEqual(parseOptions({ summaryModel: { provider: "mock" } }), {})
  assert.deepEqual(parseOptions({ debugFile: "   " }), {})
  assert.deepEqual(parseOptions({ debugFile: 42 }), {})
  assert.deepEqual(parseOptions({ debugPayloads: "yes" }), {})
})

test("readOptions merges files in order with the later file winning", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cache-compact-"))
  try {
    const personal = path.join(dir, "personal.json")
    const project = path.join(dir, "project.json")
    fs.writeFileSync(personal, JSON.stringify({ summaryMaxTokens: 100, summaryReasoningEffort: "low", debug: true }))
    fs.writeFileSync(project, JSON.stringify({ summaryMaxTokens: 200, enabled: false }))

    const merged = readOptions([personal, path.join(dir, "missing.json"), project])
    assert.deepEqual(merged, {
      summaryMaxTokens: 200,
      summaryReasoningEffort: "low",
      debug: true,
      enabled: false,
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("readOptions reports malformed JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cache-compact-"))
  try {
    const file = path.join(dir, "broken.json")
    fs.writeFileSync(file, "{ not json")
    assert.throws(() => readOptions([file]), /not valid JSON/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("parses continuation and rewindWhenNeeded, dropping wrong types", () => {
  assert.deepEqual(parseOptions({ continuation: false }), { continuation: false })
  assert.deepEqual(parseOptions({ continuation: true }), { continuation: true })
  assert.deepEqual(parseOptions({ rewindWhenNeeded: true }), { rewindWhenNeeded: true })
  // Wrong types are ignored, not defaulted: a typo must not silently flip the
  // request shape.
  assert.deepEqual(parseOptions({ continuation: "no" }), {})
  assert.deepEqual(parseOptions({ rewindWhenNeeded: "yes" }), {})
})

test("a sparse project file cannot undo continuation from the personal file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cache-compact-"))
  try {
    const personal = path.join(dir, "personal.json")
    const project = path.join(dir, "project.json")
    fs.writeFileSync(personal, JSON.stringify({ continuation: false, rewindWhenNeeded: true }))
    fs.writeFileSync(project, JSON.stringify({ summaryMaxTokens: 200 }))
    assert.deepEqual(readOptions([personal, project]), {
      continuation: false,
      rewindWhenNeeded: true,
      summaryMaxTokens: 200,
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("summaryReasoningEffort accepts \"off\"", () => {
  assert.deepEqual(parseOptions({ summaryReasoningEffort: "off" }), { summaryReasoningEffort: "off" })
  assert.deepEqual(parseOptions({ summaryReasoningEffort: "none" }), { summaryReasoningEffort: "none" })
  assert.deepEqual(parseOptions({ summaryReasoningEffort: "turbo" }), {})
})
