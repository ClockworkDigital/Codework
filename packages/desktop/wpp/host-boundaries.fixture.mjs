import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { OpenCode } from "@opencode/sdk"
import { WriteTool } from "../../core/src/tool/plugin/write.ts"
import { EditTool } from "../../core/src/tool/plugin/edit.ts"
import { SessionCompaction } from "../../core/src/session/compaction.ts"
import cookiemonster from "@cookiemonster/wpp/plugin"
import { publishProxyKey } from "@cookiemonster/wpp/proxy/localKey.mjs"
import { formatJsonToolCall } from "@cookiemonster/wpp/proxy/jsonToolFormat.mjs"
import { formatAnthropicToolCall } from "@cookiemonster/wpp/proxy/anthropicToolFormat.mjs"
import { normalizeAssistantMessage } from "@cookiemonster/wpp/proxy/toolCallNormalizer.mjs"
import { normalizeToolCallArguments } from "@cookiemonster/wpp/proxy/openaiCompat.mjs"
import { handleResponses } from "@cookiemonster/wpp/proxy/responses.mjs"

test("WPP history roundtrips preserve actual V2 write/edit inputs and reject null strings", () => {
  for (const format of [formatJsonToolCall, formatAnthropicToolCall]) {
    for (const owner of [WriteTool, EditTool]) {
      const tools = [
        {
          type: "function",
          function: { name: owner.name, parameters: Schema.toJsonSchemaDocument(owner.Input).schema },
        },
      ]

      for (const text of [
        "001",
        "true",
        "null",
        '{"value":1}',
        "```js\nconst x = 1\n```\n",
        "C:\\Users\\日本\\file.txt\r\n</parameter></invoke></function_calls>",
      ]) {
        const input =
          owner === WriteTool
            ? { path: "test.txt", content: text }
            : { path: "test.txt", oldString: text, newString: `${text} changed`, replaceAll: false }

        const result = normalizeAssistantMessage(
          format({ id: "call_stable", function: { name: owner.name, arguments: JSON.stringify(input) } }),
          { tools },
        )

        normalizeToolCallArguments(result.tool_calls, tools)
        expect(result.tool_calls).toHaveLength(1)
        expect(result.tool_calls[0].id).toBe("call_stable")
        expect(Schema.decodeUnknownSync(owner.Input)(JSON.parse(result.tool_calls[0].function.arguments))).toEqual(
          input,
        )
      }

      const input =
        owner === WriteTool
          ? { path: "test.txt", content: null }
          : { path: "test.txt", oldString: null, newString: "replacement" }

      const result = normalizeAssistantMessage(
        format({ function: { name: owner.name, arguments: JSON.stringify(input) } }),
        { tools },
      )

      normalizeToolCallArguments(result.tool_calls, tools)
      const args = JSON.parse(result.tool_calls[0].function.arguments)
      expect(args[owner === WriteTool ? "content" : "oldString"]).toBeNull()
      expect(() => Schema.decodeUnknownSync(owner.Input)(args)).toThrow()
    }
  }
})

test("real V2 initial/update compaction prompts survive Responses translation without chat affinity", async () => {
  const previous = process.env.O1_CODE_PROXY_LOGS
  process.env.O1_CODE_PROXY_LOGS = "0"

  try {
    for (const update of [false, true]) {
      for (const kind of ["compaction", "primary"]) {
        const calls = []

        const response = {
          body: "",
          setHeader() {},
          writeHead() {},
          end(text = "") {
            this.body += text
          },
        }

        await handleResponses(
          { headers: { "x-opencode-request-kind": kind } },
          response,
          {
            model: "CM_Opus5.5-XHigh",
            input: SessionCompaction.buildPrompt(update),
            stream: false,
          },
          {
            bridge: {
              hasSession: () => true,
              run: async (text, options) => {
                calls.push({ prompt: JSON.parse(text), options })

                return { response: { finalText: "## Objective\nKeep the work.", source: "network", toolCallParts: {} } }
              },
            },
          },
        )
        expect(calls).toHaveLength(1)
        expect(calls[0].prompt.purpose === "compaction").toBe(kind === "compaction")

        if (kind === "compaction") {
          expect(calls[0].options.continueThread).toBe(false)
          expect(calls[0].options.sessionKey).toBe("")
        }

        expect(JSON.parse(response.body).output[0].content[0].text).toContain("Keep the work.")
      }
    }
  } finally {
    if (previous === undefined) delete process.env.O1_CODE_PROXY_LOGS
    else process.env.O1_CODE_PROXY_LOGS = previous
  }
})

test("the live V2 provider rereads a rotated user key without restarting its backend", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wpp-managed-provider-"))
  const previousHome = process.env.XDG_CONFIG_HOME
  const previousPort = process.env.O1_CODE_PROXY_PORT
  process.env.XDG_CONFIG_HOME = directory
  const keys = []
  const headers = []

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      headers.push(request.headers)

      if (request.headers.get("authorization") !== `Bearer ${keys.at(-1)}`)
        return new Response("unauthorized", { status: 401 })
      const body = await request.json()

      const message = {
        type: "message",
        id: `msg_${headers.length}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Managed credential accepted.", annotations: [] }],
      }

      const response = {
        id: `resp_${headers.length}`,
        object: "response",
        created_at: 0,
        status: "completed",
        model: body.model,
        output: [message],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      }

      return new Response(
        [
          { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...message, status: "in_progress", content: [] },
          },
          {
            type: "response.content_part.added",
            output_index: 0,
            content_index: 0,
            item_id: message.id,
            part: { type: "output_text", text: "", annotations: [] },
          },
          {
            type: "response.output_text.delta",
            output_index: 0,
            content_index: 0,
            item_id: message.id,
            delta: "Managed credential accepted.",
          },
          { type: "response.output_item.done", output_index: 0, item: message },
          { type: "response.completed", response },
        ]
          .map(
            (event, sequence_number) =>
              `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
          )
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })

  process.env.O1_CODE_PROXY_PORT = String(server.port)
  keys.push(publishProxyKey(server.url.origin))

  try {
    await using host = await OpenCode.create({
      config: { directory, project: false, content: JSON.stringify({ model: "cookiemonster/CM_GPT6_Sol_High" }) },
      models: { fetch: false },
      fs: { filewatcher: false },
      plugins: [cookiemonster],
    })

    const session = await host.sessions.create({ title: "Managed local credential", location: { directory } })

    for (const text of ["First request", "Second request after key rotation"]) {
      if (headers.length) keys.push(publishProxyKey(server.url.origin))
      await host.sessions.prompt({ sessionID: session.id, text })
      await host.sessions.wait({ sessionID: session.id })
      expect((await host.sessions.get({ sessionID: session.id })).outcome).toBe("succeeded")
    }

    expect(headers).toHaveLength(2)
    expect(keys[0] === keys[1]).toBe(false)
    expect(headers[0].get("authorization") === `Bearer ${keys[0]}`).toBe(true)
    expect(headers[1].get("authorization") === `Bearer ${keys[1]}`).toBe(true)
    expect(headers.map((value) => value.get("x-opencode-request-kind"))).toEqual(["primary", "primary"])
  } finally {
    server.stop(true)

    if (previousHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousHome

    if (previousPort === undefined) delete process.env.O1_CODE_PROXY_PORT
    else process.env.O1_CODE_PROXY_PORT = previousPort
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
