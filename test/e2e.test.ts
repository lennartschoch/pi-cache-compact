/**
 * End-to-end test: a real Pi process, this extension loaded from source, and a
 * mock OpenAI-compatible model server that records every request body.
 *
 * The point is the summary call. Pi's default summary is a cold, re-serialized
 * prompt; ours must be a continuation of the live conversation. The assertions
 * below prove that directly, by checking the recorded HTTP bodies:
 *
 *   1. the summarization request keeps the conversation's system prompt and
 *      declares the same tools (Pi's default declares none);
 *   2. its message list starts with the exact prefix of the previous agent
 *      request — i.e. a prefix-caching server would serve it from cache;
 *   3. the summary it returns is the one Pi then persists.
 *
 * Opt-in: `npm run test:e2e`. Needs no network and no credentials.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

import { sharedPrefixLength } from "../src/debug.ts"

const enabled = process.env.PI_CACHE_COMPACT_E2E === "1"
const here = path.dirname(fileURLToPath(import.meta.url))
const extensionPath = path.resolve(here, "../src/extension.ts")

const MARKER = "PI_CC_TOOLS"
const SUMMARY_TEXT = "MOCK SUMMARY: objective, files changed, next steps."

const cliPath = path.join(
  path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
  "bundle",
  "cli.js",
)

type Recorded = { body: any; headers: http.IncomingHttpHeaders }

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part === "string" ? part : (part?.text ?? "")))
      .join("\n")
  }
  return ""
}

function lastMessage(body: any): any {
  return [...(body?.messages ?? [])].reverse()[0]
}

function startMockModel() {
  const requests: Recorded[] = []
  let toolCalls = 0

  const server = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (chunk) => (raw += chunk))
    req.on("end", () => {
      if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ object: "list", data: [{ id: "test-model", object: "model" }] }))
        return
      }
      if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
        res.writeHead(404).end()
        return
      }

      let body: any = {}
      try {
        body = JSON.parse(raw || "{}")
      } catch {
        /* ignore */
      }
      requests.push({ body, headers: req.headers })

      const usage = { prompt_tokens: 910, completion_tokens: 10, total_tokens: 920 }
      const model = body.model ?? "test-model"
      const last = lastMessage(body)
      const lastText = textOf(last?.content)
      const isSummary =
        last?.role === "user" && /(handoff|context checkpoint) summary/i.test(lastText)
      const wantsTool =
        last?.role === "user" && lastText.includes(MARKER) && toolCalls === 0 && Array.isArray(body.tools)

      const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
      const chunk = (choices: any[], extra: any = {}) => ({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: Date.now(),
        model,
        choices,
        ...extra,
      })

      if (body.stream === false) {
        res.writeHead(200, { "content-type": "application/json" })
        const message = isSummary
          ? { role: "assistant", content: SUMMARY_TEXT }
          : wantsTool
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  { id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"probe.txt"}' } },
                ],
              }
            : { role: "assistant", content: "done" }
        res.end(
          JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            created: Date.now(),
            model,
            choices: [
              {
                index: 0,
                message,
                finish_reason: wantsTool ? "tool_calls" : "stop",
              },
            ],
            usage,
          }),
        )
        return
      }

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })

      if (wantsTool) {
        toolCalls++
        res.write(
          sse(
            chunk([
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    { index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "" } },
                  ],
                },
                finish_reason: null,
              },
            ]),
          ),
        )
        res.write(
          sse(
            chunk([
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"probe.txt"}' } }] },
                finish_reason: null,
              },
            ]),
          ),
        )
        res.write(sse(chunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }], { usage })))
        res.write("data: [DONE]\n\n")
        res.end()
        return
      }

      const text = isSummary ? SUMMARY_TEXT : "done"
      res.write(sse(chunk([{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }])))
      res.write(sse(chunk([{ index: 0, delta: {}, finish_reason: "stop" }], { usage })))
      res.write("data: [DONE]\n\n")
      res.end()
    })
  })

  return new Promise<{ baseURL: string; requests: Recorded[]; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number }
      resolve({
        baseURL: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => server.close(),
      })
    })
  })
}

function runPi(
  mock: { baseURL: string },
  options: { debugFile?: string; thinking?: string } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; agentDir: string; cleanup: () => void }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cache-compact-e2e-"))
  const project = path.join(root, "project")
  const agentDir = path.join(root, "agent")
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(project, "probe.txt"), "hello probe\n")
  if (options.debugFile) {
    fs.writeFileSync(
      path.join(agentDir, "cache-compact.json"),
      JSON.stringify({ debug: true, debugFile: options.debugFile, debugPayloads: true }),
    )
  }

  fs.writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        mock: {
          baseUrl: mock.baseURL,
          api: "openai-completions",
          apiKey: "test",
          // supportsReasoningEffort would auto-detect off for a localhost URL;
          // force it so live requests carry reasoning_effort and the summary
          // request's mirroring of it is actually exercised.
          compat: { supportsReasoningEffort: true },
          // Configured provider headers: sent on every live request by pi and
          // on our summary request through the same model, proving the mock
          // records headers so the header-replay assertions mean something.
          headers: { "x-e2e-pin": "pin-42" },
          models: [{ id: "test-model", name: "Mock", reasoning: true, contextWindow: 1000, maxTokens: 512 }],
        },
      },
    }),
  )
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      defaultModel: "mock/test-model",
      compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 10 },
    }),
  )

  const args = [
    cliPath,
    "--print",
    `${MARKER} list the files in the working directory`,
    "--model",
    "mock/test-model",
    ...(options.thinking ? ["--thinking", options.thinking] : []),
    "--extension",
    extensionPath,
  ]
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    NO_COLOR: "1",
    TERM: "dumb",
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: project,
      env,
      // Close stdin: print mode otherwise waits on the pipe forever.
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
    }, 120_000)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({
        code,
        stdout,
        stderr,
        agentDir,
        cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
      })
    })
  })
}

function dump(requests: Recorded[]): string {
  return requests
    .map((request, index) => {
      const body = request.body
      const roles = (body?.messages ?? []).map((message: any) => message.role).join(",")
      const tail = textOf(lastMessage(body)?.content).slice(0, 80).replace(/\n/g, " ")
      return `#${index} tools=${body?.tools?.length ?? 0} stream=${body?.stream} roles=[${roles}] last="${tail}"`
    })
    .join("\n")
}

test(
  "summarizes as a cache-hit continuation instead of a cold prompt",
  { skip: enabled ? false : "set PI_CACHE_COMPACT_E2E=1 to run (spawns pi)", timeout: 180_000 },
  async () => {
    const mock = await startMockModel()
    const debugFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-cache-compact-debug-")), "debug.jsonl")
    let run: Awaited<ReturnType<typeof runPi>> | undefined
    try {
      run = await runPi(mock, { debugFile, thinking: "low" })
      const context = `pi exited with ${run.code}\n--- stderr ---\n${run.stderr}\n--- requests ---\n${dump(mock.requests)}`

      const summaryReq = mock.requests.find(
        (request) =>
          lastMessage(request.body)?.role === "user" &&
          /(handoff|context checkpoint) summary/i.test(textOf(lastMessage(request.body).content)),
      )
      assert.ok(summaryReq, `extension never sent a summarization request\n${context}`)

      const summaryIndex = mock.requests.indexOf(summaryReq)
      const previous = mock.requests[summaryIndex - 1]
      assert.ok(previous, `no request before the summarization\n${context}`)

      if (process.env.E2E_DEBUG) {
        for (const [index, request] of mock.requests.entries()) {
          const systems = (request.body.messages ?? [])
            .map((message: any, messageIndex: number) =>
              message.role === "system" ? `${messageIndex}:${String(message.content).length}` : undefined,
            )
            .filter(Boolean)
          console.error(`#${index} roles=[${(request.body.messages ?? []).map((m: any) => m.role).join(",")}] system@${systems.join(",")}`)
        }
        const a = String(summaryReq.body.messages[0]?.content ?? "")
        const b = String(previous.body.messages[0]?.content ?? "")
        let i = 0
        while (i < a.length && i < b.length && a[i] === b[i]) i++
        console.error(`system prompt: previous=${b.length} summary=${a.length} diverge@${i}`)
        console.error("previous ctx:", JSON.stringify(b.slice(Math.max(0, i - 80), i + 160)))
        console.error("summary  ctx:", JSON.stringify(a.slice(Math.max(0, i - 80), i + 160)))
      }

      // Reasoning effort is rendered into the prompt on some servers, so the
      // summary ask must carry exactly the effort the live prefix was sent
      // with (here: mirrored from --thinking low through the real hook).
      assert.equal(previous.body.reasoning_effort, "low", "live request should carry reasoning_effort")
      assert.equal(summaryReq.body.reasoning_effort, previous.body.reasoning_effort)

      // Wire-level header identity: configured provider headers must be on
      // the summary request exactly as on the live one — the ask has to be a
      // transport-level twin, not just a body-level twin.
      assert.equal(previous.headers["x-e2e-pin"], "pin-42", "live request lost configured headers")
      assert.equal(summaryReq.headers["x-e2e-pin"], "pin-42", "summary request did not send configured headers")


      // Same system prompt as the conversation, not Pi's summarization prompt.
      assert.equal(
        (summaryReq.body.messages[0] ?? {}).content,
        (previous.body.messages[0] ?? {}).content,
        `summarization did not reuse the conversation system prompt\n${context}`,
      )

      // Tools are still declared, so the prompt prefix is unchanged.
      assert.ok(
        Array.isArray(summaryReq.body.tools) && summaryReq.body.tools.length > 0,
        `summarization request declared no tools\n${context}`,
      )

      // The summarization request must end with the ask, and everything before
      // it must be the *complete* previous live request — a strict forward
      // continuation. Rewinding to just the dropped span is what an append-only
      // server cache (llama.cpp slots) answers with a full re-prefill, so the
      // tail must be present. This assertion is the inverse of the one it
      // replaced: the old shape was guarded in the other direction.
      const requestMessages = summaryReq.body.messages
      const last = requestMessages[requestMessages.length - 1]
      assert.equal(last?.role, "user", `summarization must end with a user ask\n${context}`)
      const askText = textOf(last?.content)
      assert.match(askText, /(handoff|context checkpoint) summary/i)
      const continuation = requestMessages.slice(0, -1)
      assert.ok(
        continuation.length > previous.body.messages.length,
        `summarization did not continue the live request (sent ${continuation.length} messages, live had ${previous.body.messages.length})\n${context}`,
      )
      assert.deepEqual(
        previous.body.messages,
        continuation.slice(0, previous.body.messages.length),
        `the live request is not a prefix of the summarization request\n${context}`,
      )
      // ...while the summary *text* is still scoped to the dropped span: the ask
      // names the boundary so the kept tail is not described twice.
      assert.match(askText, /stay in the context verbatim/, `ask lost its scope note\n${context}`)

      // Pi's default serialization must not be involved.
      assert.doesNotMatch(JSON.stringify(summaryReq.body), /<conversation>/)

      // The summary we generated is what Pi persisted as the compaction entry.
      const agentDir = run.agentDir
      const sessionText = fs
        .readdirSync(agentDir, { recursive: true })
        .filter((file) => String(file).endsWith(".jsonl"))
        .map((file) => fs.readFileSync(path.join(agentDir, String(file)), "utf8"))
        .join("\n")
      assert.match(sessionText, /"type":\s*"compaction"/, `no compaction entry persisted\n${context}`)
      assert.ok(sessionText.includes(SUMMARY_TEXT), `extension summary not persisted\n${context}`)

      // Debug records: every provider request (live turns and the
      // summarization call) must be fingerprinted, the summary request must
      // be tagged, and its rolling hashes must share a prefix with the
      // previous live request — the machine-readable cache assertion.
      const records = fs
        .readFileSync(debugFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as any)
      const providerRequests = records.filter((record) => record.kind === "provider_request")
      assert.ok(
        providerRequests.length >= 2,
        `expected fingerprints for live + summary requests, got ${providerRequests.length}\n${context}`,
      )
      const summaryRecord = providerRequests.find((record) => record.summary === true)
      assert.ok(summaryRecord, `no provider_request tagged summary=true\n${JSON.stringify(providerRequests, null, 1)}`)
      // Documents which branch built the system prompt for this run; both
      // branches must keep the prefix, but production uses "recorded".
      assert.ok(["recorded", "synthesized"].includes(summaryRecord.systemSource))
      assert.equal(summaryRecord.model, "test-model")
      assert.ok(summaryRecord.toolsCount > 0, `summary request fingerprint has no tools`)
      const summaryRecordIndex = providerRequests.indexOf(summaryRecord)
      const previousLive = providerRequests[summaryRecordIndex - 1]
      assert.ok(previousLive && previousLive.summary !== true, `no live request before the summary`)
      const shared = sharedPrefixLength(previousLive.rolling, summaryRecord.rolling)
      assert.ok(
        shared >= 1,
        `summary request shares no message prefix with the previous live request (cache would miss):\n${JSON.stringify(
          { previous: previousLive.rolling, summary: summaryRecord.rolling },
          null,
          1,
        )}`,
      )
      // The whole live request must be reusable from cache, not a shared
      // fraction of it: on an append-only cache the request is either a
      // forward continuation of the checkpoint or it re-prefills, so "shared
      // most of it" is not a hit. `shared === previous.rolling.length` says the
      // live request is a strict prefix of the ask; the extra entry is the ask.
      assert.equal(summaryRecord.requestShape, "continuation", `summary request used the rewinding shape`)
      assert.equal(
        shared,
        previousLive.rolling.length,
        `summary request does not continue the whole live request (shared ${shared} of ${previousLive.rolling.length})`,
      )
      assert.ok(
        summaryRecord.rolling.length > previousLive.rolling.length,
        `summary request is not longer than the live prefix it continues`,
      )
      if (process.env.PI_E2E_VERBOSE) {
        console.error("[e2e] summaryRecord:", JSON.stringify(summaryRecord, null, 1))
        console.error("[e2e] sharedPrefix:", shared, "of", previousLive.rolling.length)
      }
      const summaryDone = records.find((record) => record.kind === "summary_result")
      assert.ok(summaryDone, `no summary_result record`)

      // Header observability: live and summary sides must both be recorded
      // so request identity invisible in payload dumps can be diffed after
      // the fact (replica routing headers, affinity keys, cache echoes).
      const headerRecords = records.filter((record) => record.kind === "provider_headers")
      assert.ok(headerRecords.find((r) => r.summary === false), `no live provider_headers record`)
      const summaryHeaderRecord = headerRecords.find((r) => r.summary === true)
      assert.ok(summaryHeaderRecord, `no summary provider_headers record`)
      assert.equal(summaryHeaderRecord.liveCaptured, true, `summary ask did not observe a live request`)
      const responseRecords = records.filter((record) => record.kind === "provider_response")
      assert.ok(
        responseRecords.find((r) => r.summary === false),
        `no live provider_response record (after_provider_response never fired)`,
      )
      const summaryResponseRecord = responseRecords.find((r) => r.summary === true)
      assert.ok(summaryResponseRecord, `no summary provider_response record (onResponse never fired)`)
      assert.equal(summaryResponseRecord.status, 200)

      // Full payload dumps: the last live request before compaction and our
      // summarization request, as rendered by real pi-ai. Run the shipped
      // compare script over them — the same tool a human would use.
      const dumps = records.filter((record) => record.kind === "payload_dump")
      const dumpVariants = new Set(dumps.map((record) => record.variant))
      assert.ok(dumpVariants.has("live_before"), `no live_before dump; got ${[...dumpVariants]}`)
      assert.ok(dumpVariants.has("summarization"), `no summarization dump; got ${[...dumpVariants]}`)
      const dumpFile = path.join(path.dirname(debugFile), "dump-out.txt")
      const script = new URL("../scripts/compare-dumps.mjs", import.meta.url).pathname
      const { execFileSync } = await import("node:child_process")
      try {
        fs.writeFileSync(dumpFile, execFileSync("node", [script, debugFile], { encoding: "utf8" }))
      } catch (error) {
        const stdout = String((error as any).stdout ?? "")
        fs.writeFileSync(dumpFile, stdout)
        // Exit 1 means divergence found beyond the shared prefix; that is
        // allowed (the kept tail vs the ask), but a zero shared prefix is not.
        assert.match(stdout, /shared prefix=[1-9]/, `compare-dumps reported no shared prefix:\n${stdout}`)
        throw error
      }
      const compareOut = fs.readFileSync(dumpFile, "utf8")
      assert.match(compareOut, /shared prefix=[1-9]/, compareOut)
    } finally {
      mock.close()
      run?.cleanup()
    }
  },
)
