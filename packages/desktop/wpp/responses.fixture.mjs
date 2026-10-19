import { describe, expect, test } from "bun:test"
import { handleResponses } from "@cookiemonster/wpp/proxy/responses.mjs"
import { AI } from "../../ai/src/promise.ts"
import { OpenAI } from "../../ai/src/providers.ts"
import { createServer } from "node:http"
import { readJson } from "@cookiemonster/wpp/proxy/server.mjs"

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

describe("WPP Responses compatibility", () => {
  for (const stream of [false, true]) {
    test(`returns text and multiple owned images with stream=${stream}`, async () => {
      const response = writer()
      await handleResponses(
        { headers: {} },
        response,
        {
          model: "CM_GPT6.1_Sol",
          input: "Use the available tools to draw circles.",
          tools: [{ type: "function", name: "draw", parameters: { type: "object", properties: {} } }],
          stream,
        },
        {
          bridge: bridge('<wpp_artifact type="image">Draw blue circles.</wpp_artifact>\nHere are the circles.', [
            { mime: "image/png", data: PNG },
            { mime: "image/jpeg", data: "AQID" },
          ]),
        },
      )
      const result = stream ? events(response).at(-1).response : JSON.parse(response.body)
      expect(result.status).toBe("completed")
      expect(result.output.map((item) => item.type)).toEqual([
        "message",
        "image_generation_call",
        "image_generation_call",
      ])
      expect(result.output[0].content[0].text).toBe("Here are the circles.")
      expect(result.output[1]).toMatchObject({ result: PNG, output_format: "png", status: "completed" })
      expect(result.output[2]).toMatchObject({ result: "AQID", output_format: "jpeg" })
      if (stream) {
        expect(events(response).filter((event) => event.type === "response.output_item.done")).toHaveLength(3)
        expect(events(response).map((event) => event.sequence_number)).toEqual(
          events(response).map((_, index) => index),
        )
      }
    })
  }

  test("the production OpenAI parser receives images and can replay them on the next request", async () => {
    const prompts = []
    const server = createServer(async (request, response) => {
      await handleResponses(request, response, await readJson(request), {
        bridge: {
          hasSession: () => false,
          run: async (prompt, options) => {
            prompts.push({ prompt: JSON.parse(prompt), images: options.images })
            return {
              response: { finalText: "A circle.", images: [{ mime: "image/png", data: PNG }], toolCallParts: {} },
            }
          },
        },
      })
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const ai = AI.make()
    try {
      const model = OpenAI.configure({
        apiKey: "fixture",
        baseURL: `http://127.0.0.1:${server.address().port}/v1`,
      }).responses("CM_GPT6.1_Sol")
      const first = { role: "user", content: [{ type: "text", text: "Draw a circle." }] }
      const response = await ai.llm.generate({ model, messages: [first] })
      const result = response.events.find((event) => event.type === "tool-result")
      expect(result).toMatchObject({
        providerExecuted: true,
        name: "image_generation",
        result: { type: "content", value: [{ type: "file", mime: "image/png", uri: `data:image/png;base64,${PNG}` }] },
      })
      await ai.llm.generate({
        model,
        messages: [first, response.message, { role: "user", content: [{ type: "text", text: "Make it blue." }] }],
      })
      expect(prompts).toHaveLength(2)
      expect(prompts[1].images).toHaveLength(1)
      expect(prompts[1].images[0].mimeType).toBe("image/png")
    } finally {
      await ai.dispose()
      await new Promise((resolve) => server.close(resolve))
    }
  })

  test("preserves function calls and tool outputs across Responses requests", async () => {
    const prompts = []
    const response = writer()
    await handleResponses(
      { headers: {} },
      response,
      {
        model: "CM_GPT6.1_Sol",
        stream: true,
        input: [
          { role: "user", content: "Read a file." },
          { type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
          { type: "function_call_output", call_id: "call_1", output: "file contents" },
        ],
        tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
      },
      {
        bridge: {
          hasSession: () => false,
          run: async (prompt) => {
            prompts.push(JSON.parse(prompt))
            return { response: { finalText: '{"type":"tool_call","tool":"read","args":{}}', toolCallParts: {} } }
          },
        },
      },
    )
    expect(prompts[0].messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "call_1", content: "file contents" })
    const result = events(response).at(-1).response
    expect(result.output).toHaveLength(1)
    expect(result.output[0]).toMatchObject({ type: "function_call", name: "read", arguments: "{}" })
  })

  for (const ids of [["call_read"], ["call_read", "call_read"], ["call_read", "call_other"]])
    test(`the production parser receives one lifecycle per XML identity: ${ids.join(", ")}`, async () => {
      const calls = ids
        .map((id) => `<invoke id="${id}" name="read"><parameter name="filePath">a.txt</parameter></invoke>`)
        .join("")
      const server = createServer(async (request, response) => {
        await handleResponses(request, response, await readJson(request), {
          bridge: bridge(`<function_calls>${calls}</function_calls>`),
        })
      })
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
      const ai = AI.make()
      try {
        const model = OpenAI.configure({
          apiKey: "fixture",
          baseURL: `http://127.0.0.1:${server.address().port}/v1`,
        }).responses("CM_GPT6.1_Sol")
        const response = await ai.llm.generate({
          model,
          messages: [{ role: "user", content: [{ type: "text", text: "Read a.txt." }] }],
          tools: [
            {
              name: "read",
              description: "Read a file",
              inputSchema: { type: "object", properties: { filePath: { type: "string" } } },
            },
          ],
        })
        for (const type of ["tool-input-start", "tool-input-end", "tool-call"])
          expect(response.events.filter((event) => event.type === type).map((event) => event.id)).toEqual([
            ...new Set(ids),
          ])
      } finally {
        await ai.dispose()
        await new Promise((resolve) => server.close(resolve))
      }
    })

  for (const [name, file] of [
    ["read", "b.txt"],
    ["write", "a.txt"],
  ])
    test(`rejects a reused XML identity with conflicting payload: ${name} ${file}`, async () => {
      const response = writer()
      await handleResponses(
        { headers: {} },
        response,
        {
          model: "CM_GPT6.1_Sol",
          stream: true,
          input: "Read a file.",
          tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
        },
        {
          bridge: bridge(`<function_calls>
      <invoke id="call_read" name="read"><parameter name="filePath">a.txt</parameter></invoke>
      <invoke id="call_read" name="${name}"><parameter name="filePath">${file}</parameter></invoke>
    </function_calls>`),
        },
      )
      expect(events(response).at(-1)).toMatchObject({
        type: "response.failed",
        response: { error: { code: "o1_code_conflicting_tool_call" } },
      })
      expect(events(response).some((event) => event.item?.type === "function_call")).toBe(false)
    })

  test("returns image-only output and rejects unsupported inputs before running WPP", async () => {
    const response = writer()
    await handleResponses(
      { headers: {} },
      response,
      { input: "Draw.", stream: true },
      { bridge: bridge("", [{ mime: "image/png", data: PNG }]) },
    )
    expect(
      events(response)
        .at(-1)
        .response.output.map((item) => item.type),
    ).toEqual(["image_generation_call"])
    for (const input of [
      null,
      { input: 4 },
      { input: "hi", tools: {} },
      { input: "hi", previous_response_id: "stored" },
      { input: [{ type: "item_reference", id: "stored" }] },
    ]) {
      expect(() => handleResponses({ headers: {} }, writer(), input)).toThrow()
    }
  })

  test("ends failed streams without reporting a completed response", async () => {
    const response = writer()
    await handleResponses(
      { headers: {} },
      response,
      { input: "Draw.", stream: true },
      {
        bridge: {
          hasSession: () => false,
          run: async () => {
            throw Object.assign(new Error("Image download failed"), {
              type: "wpp_image_download_failed",
              statusCode: 502,
            })
          },
        },
      },
    )
    expect(events(response).at(-1)).toMatchObject({
      type: "response.failed",
      response: { status: "failed", error: { code: "wpp_image_download_failed" } },
    })
    expect(events(response).some((event) => event.type === "response.completed")).toBe(false)
  })
})

function bridge(finalText, images) {
  return { hasSession: () => false, run: async () => ({ response: { finalText, images, toolCallParts: {} } }) }
}

function writer() {
  return {
    body: "",
    setHeader() {},
    writeHead() {},
    write(chunk) {
      this.body += chunk
    },
    end(chunk = "") {
      this.body += chunk
    },
  }
}

function events(response) {
  return response.body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)))
}
