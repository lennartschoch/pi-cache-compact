/**
 * Debug logging for pi-cache-compact.
 *
 * `debug: true` logs decisions to stderr. Under a daemon host (Paseo, IDE
 * wrappers) stderr is not persisted anywhere readable after the fact, so
 * `debugFile` additionally appends every record as one JSON line to a file.
 *
 * The records that matter for cache debugging are `provider_request`
 * fingerprints. Live agent turns are fingerprinted in the
 * `before_provider_request` hook; our own summarization call bypasses the
 * extension runner, so it is fingerprinted via the `onPayload` option pi-ai
 * invokes with the exact outgoing params. Both hash each message with a
 * rolling hash:
 *
 *   rolling[i] = H(rolling[i-1] + H(message[i]))
 *
 * Two records then compare in O(n) without storing payloads: the number of
 * leading equal rolling hashes is exactly the shared message prefix, so the
 * first differing index is where a prefix-caching server would miss. If the
 * shared prefix is 0, the prompt/tools head diverged — the bug class that
 * makes every compaction a cold request.
 *
 * Pure Node (crypto/fs only) so the helpers are unit-testable without Pi.
 */

import { createHash } from "node:crypto"
import { appendFileSync } from "node:fs"

const HASH_LENGTH = 12

function hashUpdate(prev: string, value: unknown): string {
  // JSON.stringify drops undefined keys exactly like the wire serializer;
  // String(value) keeps unserializable values from throwing.
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    text = String(value)
  }
  return createHash("sha256")
    .update(`${prev}${text}`)
    .digest("hex")
    .slice(0, HASH_LENGTH)
}

/**
 * Detach a value from later mutation by round-tripping through JSON.
 * Used for payload dumps: the captured request object may be reused or
 * mutated after the hook fires, and a dump taken at write time would show
 * the wrong bytes. Falls back to a string for unserializable values.
 */
export function snapshot(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

/** Stable short hash of any JSON-ish value. */
export function shortHash(value: unknown): string {
  return hashUpdate("", value)
}

/**
 * Header names whose values must never reach the debug file. The keys stay
 * visible — which headers exist is the diagnostic; the values are secrets.
 */
const REDACTED_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "api-key",
  "x-api-key",
  "x-goog-api-key",
  "openai-api-key",
  "anthropic-api-key",
  "x-amz-security-token",
  "x-auth-token",
  "x-session-token",
  "cookie",
  "set-cookie",
])

/**
 * Copy a header bag for logging: values stringified, sensitive ones replaced
 * with `"[redacted]"` (name match is case-insensitive per RFC 7230). The
 * `null` value pi uses to delete a header is kept as the string "null" —
 * that it is a fact worth seeing.
 */
export function redactHeaders(
  headers: Record<string, unknown> | undefined | null,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers || typeof headers !== "object") return out
  for (const [name, value] of Object.entries(headers)) {
    out[name] = REDACTED_HEADER_NAMES.has(name.toLowerCase())
      ? "[redacted]"
      : String(value)
  }
  return out
}

/**
 * Rolling fingerprints over a message list. Equal prefixes of `rolling`
 * guarantee equal message prefixes; the first difference marks divergence.
 */
export function rollingMessageHashes(messages: readonly unknown[]): string[] {
  let prev = ""
  return messages.map((message) => {
    prev = hashUpdate(prev, message)
    return prev
  })
}

/** Number of leading equal entries — the shared message prefix length. */
export function sharedPrefixLength(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return i
  }
  return n
}

function messageText(message: unknown): string {
  const content = (message as { content?: unknown })?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string" ? part : String((part as { text?: unknown })?.text ?? ""),
      )
      .join("\n")
  }
  return ""
}

/**
 * Fingerprint a provider payload without retaining it. The payload shape is
 * provider-specific (this is the body right before the HTTP call), so every
 * field is probed defensively; unknown shapes still yield message hashes.
 */
export function fingerprintPayload(payload: unknown): Record<string, unknown> {
  let body: Record<string, unknown> = {}
  try {
    body = (payload ?? {}) as Record<string, unknown>
  } catch {
    /* keep {} */
  }
  const messages = Array.isArray(body.messages) ? body.messages : []
  const tools = Array.isArray(body.tools) ? body.tools : []
  const rolling = rollingMessageHashes(messages)
  const last = messages[messages.length - 1] as { role?: unknown } | undefined
  return {
    model: typeof body.model === "string" ? body.model : undefined,
    stream: body.stream,
    toolChoice: body.tool_choice ?? body.tools_choice,
    toolsCount: tools.length,
    toolsHash: shortHash(tools),
    messageCount: messages.length,
    firstMessageHash: rolling[0] ?? null,
    lastMessageRole: typeof last?.role === "string" ? last.role : undefined,
    lastMessageHash: messages.length ? shortHash(last) : null,
    lastMessageTextHash: messages.length ? shortHash(messageText(last)) : null,
    // 12 hex chars per message; a 500-message transcript costs ~6 KB.
    rolling,
  }
}

/**
 * stderr lines for humans + JSONL records for post-hoc analysis. Never
 * throws: logging must not break a compaction or a provider request.
 */
export class DebugLogger {
  readonly enabled: boolean
  readonly file?: string

  constructor(enabled: boolean, file?: string) {
    this.enabled = enabled
    this.file = file
  }

  /** Human-readable decision line (stderr). */
  log(message: string, extra: Record<string, unknown> = {}): void {
    if (!this.enabled) return
    try {
      process.stderr.write(`[cache-compact] ${message} ${JSON.stringify(extra)}\n`)
    } catch {
      /* never throw from logging */
    }
  }

  /**
   * Structured record. Appended as one JSON line to `debugFile`; silently
   * dropped when no file is configured (the high-volume records, like
   * provider_request fingerprints, are not worth flooding stderr with).
   */
  record(kind: string, extra: Record<string, unknown> = {}): void {
    if (!this.enabled || !this.file) return
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), kind, ...extra })
      appendFileSync(this.file, `${line}\n`)
    } catch {
      /* never throw from logging */
    }
  }

  /** Decision line + structured record. */
  both(kind: string, extra: Record<string, unknown> = {}): void {
    this.log(kind, extra)
    this.record(kind, extra)
  }
}
