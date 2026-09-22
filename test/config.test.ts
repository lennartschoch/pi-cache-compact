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
      cacheRetention: "long",
      toolChoice: "none",
      debug: true,
      nonsense: "ignored",
    }),
    {
      enabled: false,
      models: ["mock/test-model"],
      summaryModel: { provider: "mock", id: "small" },
      summaryPrompt: "  do it  ",
      summaryMaxTokens: 512,
      cacheRetention: "long",
      toolChoice: "none",
      debug: true,
    },
  )
})

test("parseOptions rejects malformed values without throwing", () => {
  assert.deepEqual(parseOptions(null), {})
  assert.deepEqual(parseOptions("nope"), {})
  assert.deepEqual(parseOptions({ models: [], summaryMaxTokens: -3, cacheRetention: "forever" }), {})
  assert.deepEqual(parseOptions({ summaryModel: { provider: "mock" } }), {})
})

test("readOptions merges files in order with the later file winning", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cache-compact-"))
  try {
    const personal = path.join(dir, "personal.json")
    const project = path.join(dir, "project.json")
    fs.writeFileSync(personal, JSON.stringify({ summaryMaxTokens: 100, debug: true }))
    fs.writeFileSync(project, JSON.stringify({ summaryMaxTokens: 200, enabled: false }))

    const merged = readOptions([personal, path.join(dir, "missing.json"), project])
    assert.deepEqual(merged, { summaryMaxTokens: 200, debug: true, enabled: false })
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
