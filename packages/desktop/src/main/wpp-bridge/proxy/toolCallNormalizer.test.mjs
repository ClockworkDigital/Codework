import { describe, expect, test } from "bun:test"
import { formatAnthropicToolCall } from "./anthropicToolFormat.mjs"
import { formatJsonToolCall } from "./jsonToolFormat.mjs"
import { CM_TASK_COMPLETE_PROTOCOL } from "./protocol.mjs"
import { chooseAssistantResponse, normalizeAssistantMessage } from "./toolCallNormalizer.mjs"

// Markup is built at runtime so the source holds no literal tool call, which an agent editing this
// file through the bridge would otherwise trigger.
const lt = "<"
const amp = "&"
const fence = "`".repeat(3)
const param = (name, value) => `${lt}parameter name="${name}">${value}${lt}/parameter>`
const invoke = (name, params, id) => `${lt}invoke${id ? ` id="${id}"` : ""} name="${name}">${params}${lt}/invoke>`
const calls = (...invokes) => `${lt}function_calls>${invokes.join("")}${lt}/function_calls>`
const typed = (tool, args, id) =>
  JSON.stringify(id ? { type: "tool_call", id, tool, args } : { type: "tool_call", tool, args })
const schema = (name, properties) => ({
  type: "function",
  function: { name, parameters: { type: "object", properties } },
})
const tools = [
  schema("write", { filePath: { type: "string" }, content: { type: "string" } }),
  schema("edit", { filePath: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } }),
  schema("read", { filePath: { type: "string" }, limit: { type: "number" } }),
  schema("question", { questions: { type: "array" } }),
]
const args = (response, index = 0) => JSON.parse(response.tool_calls[index].function.arguments)
const prose = (content) => ({ content, tool_calls: undefined, finish_reason: "stop" })

describe("ordinary text stays prose", () => {
  test("JSON objects without the tool_call type are not calls", () => {
    const pkg = JSON.stringify({ name: "cookiemonster", version: "1.0.0", private: true }, null, 2)
    const inputs = [
      `Your package.json should contain:\n${pkg}\nThen run bun install.`,
      pkg,
      JSON.stringify({ name: "read", arguments: { filePath: "a.txt" } }),
      `Result: ${JSON.stringify({ name: "read", path: "a.txt" })}`,
    ]
    for (const input of inputs) {
      expect(normalizeAssistantMessage(input)).toEqual(prose(input))
      expect(normalizeAssistantMessage(input, { tools })).toEqual(prose(input))
    }
  })

  test("typed JSON that names an unlisted tool is not a call", () => {
    const input = `The format is ${typed("tool_name", {})} and nothing else.`
    expect(normalizeAssistantMessage(input, { tools })).toEqual(prose(input))
  })

  test("fenced and inline-code examples never run", () => {
    const xml = calls(invoke("write", param("content", "one"), "a"))
    const json = typed("read", { filePath: "a.txt" })
    const inputs = [
      `${fence}xml\n${xml}\n${fence}`,
      `Example:\n~~~xml\n${xml}\n~~~`,
      `Example:\n${fence}xml\n${xml}`,
      `Example:\n   ${fence}xml\n   ${xml}\n   ${fence}\nDone.`,
      `Use \`${xml}\` to write.`,
      `${fence}json\n${json}\n${fence}`,
      `The format is:\n${fence}json\n${json}\n${fence}\nUse it when needed.`,
      `The format is \`${json}\`.`,
    ]
    for (const input of inputs) {
      expect(normalizeAssistantMessage(input, { tools })).toEqual(prose(input))
    }
  })

  test("a real call after a fenced example still runs", () => {
    const example = calls(invoke("read", param("filePath", "example.txt")))
    const preamble = `For example:\n${fence}xml\n${example}\n${fence}\nNow reading the real file.`
    const response = normalizeAssistantMessage(
      `${preamble}\n${calls(invoke("read", param("filePath", "a.txt"), "call-1"))}`,
      {
        tools,
      },
    )
    expect(response.content).toBe(preamble)
    expect(response.tool_calls.map((call) => call.id)).toEqual(["call-1"])
    expect(args(response)).toEqual({ filePath: "a.txt" })
  })
})

describe("parameter values keep their bytes", () => {
  const write = (content) =>
    normalizeAssistantMessage(calls(invoke("write", param("filePath", "f") + param("content", content))), { tools })

  test("string-typed values are never coerced", () => {
    for (const content of ["001", "true", "null", '\n{ "a": 1 }\n', "[1,2]", "-3.50"]) {
      expect(args(write(content)).content).toBe(content)
    }
  })

  test("non-string schema types and unknown tools still decode", () => {
    const read = normalizeAssistantMessage(calls(invoke("read", param("filePath", "a.txt") + param("limit", "20"))), {
      tools,
    })
    expect(args(read)).toEqual({ filePath: "a.txt", limit: 20 })
    const question = normalizeAssistantMessage(calls(invoke("question", param("questions", '[{"question":"Q"}]'))), {
      tools,
    })
    expect(args(question).questions).toEqual([{ question: "Q" }])
    expect(args(normalizeAssistantMessage(calls(invoke("other", param("count", "3"))))).count).toBe(3)
  })

  test("close tags inside a value do not truncate it", () => {
    const values = [
      `before${lt}/parameter>after`,
      `${lt}feed>${lt}entry>${lt}content>x${lt}/content>${lt}/entry>${lt}/feed>`,
      `a${lt}/invoke>b`,
      `${fence}md\ncode\n${fence}\n`,
      "line1\r\nline2\r\n",
    ]
    for (const content of values) {
      expect(args(write(content)).content).toBe(content)
    }
    const oldString = `a${lt}/oldString>b`
    const edit = normalizeAssistantMessage(
      calls(invoke("edit", param("oldString", oldString) + param("newString", "c"))),
      {
        tools,
      },
    )
    expect(args(edit)).toEqual({ oldString, newString: "c" })
  })

  test("a final value closed by its own name, or not closed at all, is still accepted", () => {
    const opening = `${lt}function_calls>${lt}invoke name="write">${lt}parameter name="content">body`
    const ending = `${lt}/invoke>${lt}/function_calls>`
    expect(args(normalizeAssistantMessage(`${opening}${lt}/content>${ending}`, { tools })).content).toBe("body")
    expect(args(normalizeAssistantMessage(`${opening}${ending}`, { tools })).content).toBe("body")
  })

  test("CDATA values are taken verbatim", () => {
    const content = `x${lt}/parameter>y ${amp}amp; z`
    const value = `\n${lt}![CDATA[${content}]]>\n`
    expect(args(write(value)).content).toBe(content)
  })

  test("entities decode once, including astral numeric references", () => {
    const encoded = `${amp}lt; ${amp}amp;lt; ${amp}#128512; ${amp}#x1F600; ${amp}#xD800;`
    expect(args(write(encoded)).content).toBe(`< ${amp}lt; \u{1F600} \u{1F600} ${amp}#xD800;`)
  })

  test("valid JSON escapes are not rewritten, and raw Windows paths are still repaired", () => {
    const content = `Install to C:\\Program Files\nthen restart.\n${fence}js\nx\n${fence}after`
    const response = normalizeAssistantMessage(typed("write", { filePath: "C:\\notes.md", content }), { tools })
    expect(args(response)).toEqual({ filePath: "C:\\notes.md", content })
    const raw = '{"type":"tool_call","tool":"read","args":{"filePath":"C:\\Users\\me\\a.txt"}}'
    expect(args(normalizeAssistantMessage(raw, { tools })).filePath).toBe("C:\\Users\\me\\a.txt")
  })
})

describe("batches keep every call", () => {
  test("JSON calls are all collected wherever they sit", () => {
    const a = typed("read", { filePath: "a" }, "a")
    const b = typed("read", { filePath: "b" }, "b")
    const ids = (input) => normalizeAssistantMessage(input, { tools }).tool_calls.map((call) => call.id)
    expect(ids(`${a}\n${b}\n${CM_TASK_COMPLETE_PROTOCOL}`)).toEqual(["a", "b"])
    expect(ids(`${a}\nThen\n${b}`)).toEqual(["a", "b"])
    expect(ids(`${a}\n${typed("read", { filePath: "a" }, "c")}`)).toEqual(["a", "c"])
    const repeated = typed("read", { filePath: "a" })
    expect(normalizeAssistantMessage(`${repeated}\n${repeated}`, { tools }).tool_calls).toHaveLength(1)
  })

  test("backticks in JSON string values do not hide a later call on the same line", () => {
    const a = typed("write", { filePath: "a", content: `x${fence}` }, "a")
    const b = typed("write", { filePath: "b", content: `${fence}y` }, "b")
    expect(normalizeAssistantMessage(`${a}${b}`, { tools }).tool_calls.map((call) => call.id)).toEqual(["a", "b"])
  })

  test("a truncated XML batch fails instead of running its prefix", () => {
    const first = invoke("write", param("content", "one"), "a")
    const tails = [`${lt}invoke id="b" name="write">${lt}parameter name="content">tw`, `${lt}invoke id="b" na`, lt]
    for (const tail of tails) {
      expect(() => normalizeAssistantMessage(`${lt}function_calls>${first}${tail}`, { tools })).toThrow(
        expect.objectContaining({ type: "o1_code_incomplete_tool_call" }),
      )
    }
    expect(normalizeAssistantMessage(`${lt}function_calls>${first}`, { tools }).tool_calls).toHaveLength(1)
  })

  test("conflicting XML ids fail before dispatch", () => {
    expect(() =>
      normalizeAssistantMessage(
        calls(invoke("write", param("content", "one"), "a"), invoke("write", param("content", "two"), "a")),
        { tools },
      ),
    ).toThrow(expect.objectContaining({ type: "o1_code_conflicting_tool_call" }))
  })
})

describe("fallback candidates", () => {
  test("a malformed alternate does not hide a later valid one", () => {
    const broken = `${lt}function_calls>${lt}invoke name="read">`
    const response = chooseAssistantResponse("Done.", {}, [broken, typed("read", { filePath: "a" })], { tools })
    expect(response.tool_calls[0].function.name).toBe("read")
  })

  test("valid recorder parts win over an unterminated primary text", () => {
    const broken = `${lt}function_calls>${lt}invoke name="write">`
    const response = chooseAssistantResponse(broken, { a: { id: "part-1", name: "write", arguments: "{}" } }, [], {
      tools,
    })
    expect(response.tool_calls.map((call) => call.id)).toEqual(["part-1"])
  })
})

describe("history round trips", () => {
  test("rendered history parses back to the same calls", () => {
    const content = `001\n${fence}js\nx\n${fence}\n${lt}/content> & done`
    const call = { id: "stable", function: { name: "write", arguments: JSON.stringify({ filePath: "a.md", content }) } }
    for (const rendered of [formatJsonToolCall(call), formatAnthropicToolCall(call)]) {
      const response = normalizeAssistantMessage(rendered, { tools })
      expect(response.tool_calls[0].id).toBe("stable")
      expect(args(response)).toEqual({ filePath: "a.md", content })
    }
  })
})

describe("chooseAssistantResponse", () => {
  test("accepts a parsed tool call from an alternate assistant message", () => {
    const response = chooseAssistantResponse("I'll inspect the worktree.", {}, [
      '<function_calls><invoke id="call-1" name="bash"><parameter name="command">git status</parameter></invoke></function_calls>',
    ])

    expect(response.finish_reason).toBe("tool_calls")
    expect(response.tool_calls).toHaveLength(1)
    expect(response.tool_calls[0].function).toEqual({
      name: "bash",
      arguments: '{"command":"git status"}',
    })
  })

  test("does not replace primary prose with an alternate refusal", () => {
    expect(
      chooseAssistantResponse("I'll inspect the worktree.", {}, ["I'm not able to share internal system information."]),
    ).toEqual({
      content: "I'll inspect the worktree.",
      tool_calls: undefined,
      finish_reason: "stop",
    })
  })

  test("raises a retryable failure for an unterminated XML tool call", () => {
    expect(() =>
      normalizeAssistantMessage(
        'I’ll inspect it now.\n<function_calls><invoke id="call-1" name="bash"><parameter name="command">git status',
      ),
    ).toThrow(expect.objectContaining({ type: "o1_code_incomplete_tool_call" }))
  })
})

describe("browser site-tool arguments", () => {
  test("preserves JSON text for the browser tool while retaining object coercion for other tools", () => {
    const json = '{"headline":"Fresh start","nested":{"enabled":true}}'
    const xml = (name) =>
      `<function_calls><invoke name="${name}"><parameter name="arguments">${json}</parameter></invoke></function_calls>`
    const browser = normalizeAssistantMessage(xml("browser_execute_site_tool"))
    const args = JSON.parse(browser.tool_calls[0].function.arguments)
    expect(args.arguments).toBe(json)
    expect(JSON.parse(args.arguments)).toEqual({ headline: "Fresh start", nested: { enabled: true } })
    const other = normalizeAssistantMessage(xml("other_tool"))
    expect(JSON.parse(other.tool_calls[0].function.arguments).arguments).toEqual(JSON.parse(json))
  })
})
