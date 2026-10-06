#!/usr/bin/env node
/**
 * Diff the full request payloads captured by pi-cache-compact's
 * `debugPayloads` option.
 *
 *   node scripts/compare-dumps.mjs <debugFile.jsonl> [variantsA variantsB]
 *
 * Defaults to comparing `live_before` vs `summarization` — the pair that
 * answers "why did the summary request miss the prefix cache". Use
 * `summarization live_after` or `live_before live_after` for the other edges.
 * The last dump of each variant wins. For every comparison the question is
 * the same: is B a byte-identical extension of A's prefix (cache hit), and if
 * not, where do they first differ?
 */
import { readFileSync } from "node:fs"

const [, , file, variantA = "live_before", variantB = "summarization"] = process.argv
if (!file) {
  console.error("usage: compare-dumps.mjs <debugFile.jsonl> [variantA variantB]")
  process.exit(2)
}

const dumps = []
for (const line of readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue
  let record
  try {
    record = JSON.parse(line)
  } catch {
    continue
  }
  if (record.kind === "payload_dump") dumps.push(record)
}
const lastOf = (variant) => [...dumps].reverse().find((d) => d.variant === variant)
const A = lastOf(variantA)
const B = lastOf(variantB)
if (!A || !B) {
  console.error(
    `no payload_dump for ${JSON.stringify(variantA)} / ${JSON.stringify(variantB)}; ` +
      `found variants: ${[...new Set(dumps.map((d) => d.variant))].join(", ") || "(none)"}`,
  )
  process.exit(1)
}
if (A.sessionId !== B.sessionId) {
  console.error(`warning: dumps come from different sessions (${A.sessionId} vs ${B.sessionId})`)
}

const pa = A.payload ?? {}
const pb = B.payload ?? {}
const json = (v) => JSON.stringify(v) ?? String(v)
const clip = (s, n = 400) => (s.length > n ? `${s.slice(0, n)}…[${s.length} bytes]` : s)
let breaking = false
const report = (label, detail) => {
  console.log(`\n== ${label}\n${detail}`)
}

// 1. Request parameters (max_tokens etc. differ legitimately; note them).
const paramDiff = []
for (const key of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
  if (key === "messages" || key === "tools") continue
  if (json(pa[key]) !== json(pb[key])) paramDiff.push(`  ${key}: ${clip(json(pa[key]), 80)} -> ${clip(json(pb[key]), 80)}`)
}
if (paramDiff.length) console.log(`\n== parameters (may be intentional)\n${paramDiff.join("\n")}`)

// 2. Tool declarations — a reordered or re-serialized list breaks the cache.
const ta = Array.isArray(pa.tools) ? pa.tools : []
const tb = Array.isArray(pb.tools) ? pb.tools : []
if (json(ta) !== json(tb)) {
  const name = (t) => t?.function?.name ?? t?.name ?? json(t).slice(0, 30)
  const la = ta.map(name)
  const lb = tb.map(name)
  const lines = [`  A: ${la.length} tools, B: ${lb.length} tools`]
  const missing = la.filter((n) => !lb.includes(n))
  const added = lb.filter((n) => !la.includes(n))
  if (missing.length) lines.push(`  only in ${variantA}: ${missing.join(", ")}`)
  if (added.length) lines.push(`  only in ${variantB}: ${added.join(", ")}`)
  if (!missing.length && !added.length && json(ta) !== json(tb)) {
    lines.push("  same tool names, different declaration bytes:")
    for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
      if (json(ta[i]) !== json(tb[i])) {
        lines.push(`  first differing declaration at index ${i}:\n    A: ${clip(json(ta[i]))}\n    B: ${clip(json(tb[i]))}`)
        break
      }
    }
  }
  breaking = true
  report("tools diverge (cache-breaking)", lines.join("\n"))
}

// 3. Messages — byte-level prefix comparison.
const ma = Array.isArray(pa.messages) ? pa.messages : []
const mb = Array.isArray(pb.messages) ? pb.messages : []
let shared = 0
while (shared < Math.min(ma.length, mb.length) && json(ma[shared]) === json(mb[shared])) shared++
console.log(`\nmessages: ${variantA}=${ma.length}, ${variantB}=${mb.length}, shared prefix=${shared}`)
if (shared >= Math.min(ma.length, mb.length) && shared > 0) {
  // One is a strict prefix of the other: clean cache behaviour up to the
  // shorter request's end. For live_before vs summarization the expected
  // shared length is the dropped span (everything before firstKeptEntryId).
  console.log(`RESULT: one request is a byte-identical prefix of the other (cache covers the first ${shared} messages).`)
} else if (shared === 0) {
  breaking = true
  report("first message diverges (prompt head; full cache miss)", `  A[0]: ${clip(json(ma[0]))}\n  B[0]: ${clip(json(mb[0]))}`)
} else {
  const a = json(ma[shared])
  const b = json(mb[shared])
  let off = 0
  while (off < Math.min(a.length, b.length) && a[off] === b[off]) off++
  const ctx = (s, at) => clip(s.slice(Math.max(0, at - 60), at + 120))
  const lines = [
    `  first divergence: message index ${shared} (roles: ${ma[shared]?.role ?? "∅"} vs ${mb[shared]?.role ?? "∅"})`,
    `  cache can cover at most the first ${shared} messages; compare the two messages below to tell an intentional cut (kept tail vs ask) from byte drift (same logical message, different bytes)`,
    `  within serialized message at byte ${off}:`,
    `    A: …${ctx(a, off)}`,
    `    B: …${ctx(b, off)}`,
  ]
  // Divergence at a boundary is expected (kept tail vs ask); divergence at
  // the same logical message is the bug. Printed either way — judge below.
  report(`messages diverge at index ${shared}; cache covers the first ${shared}`, lines.join("\n"))
}
if (shared === 0 || breaking) process.exitCode = 1
