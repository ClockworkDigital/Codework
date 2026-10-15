// SAFETY: This fixture owns its synthetic native objects, runtime probes and malformed inputs; partial shapes deliberately exercise the production guards.
/* oxlint-disable anti-slop/no-reflect-get, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, no-restricted-globals */
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import vm from "node:vm"

type ContentHarness = {
  beginNetworkCapture: () => { runId: string }
  waitForNetworkResponse: (input: { runId: string }) => Promise<unknown>
  deliver: (record: Record<string, unknown>) => void
  timers: Map<number, () => void>
  imageAttachmentDesync: (error: Error) => Error & { statusCode?: number; type?: string }
  pickTokenPill: (elements: unknown[]) => { value: number; text: string } | null
  waitForUpdatedTokenPill: (
    before: { totalTokens: number } | null,
    options: {
      read: () => { totalTokens: number; source: string; scope: string; fidelity: string } | null
      sleep: () => Promise<void>
      timeoutMs: number
      pollMs: number
    },
  ) => Promise<{ measurement: Record<string, unknown> | null; observation: Record<string, unknown> }>
}

const harness = await loadContentHarness()

test.each(["done", "finishReason"])("settles captured %s without waiting for the DOM poll", async (terminal) => {
  const h = await loadContentHarness()
  const { runId } = h.beginNetworkCapture()
  const result = {
    id: "response",
    runId,
    method: "POST",
    finalText: "complete",
    [terminal]: terminal === "done" ? true : "stop",
  }
  let settled = false
  const waiting = h.waitForNetworkResponse({ runId }).then((record) => {
    settled = true
    return record
  })
  try {
    h.deliver({ ...result, runId: "other-run" })
    await Promise.resolve()
    expect(settled).toBe(false)
    h.deliver(result)
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(true)
    expect(await waiting).toEqual(result)
    expect(h.timers.size).toBe(0)
  } finally {
    h.timers.forEach((callback) => callback())
    await waiting
  }
})

describe("WPP content image attachment", () => {
  test("classifies an unknown trusted-paste outcome as a pre-submit attachment desync", () => {
    const error = harness.imageAttachmentDesync(
      new Error('Timed out waiting for main action "pasteImages" after 60000 ms.'),
    )

    expect(error).toMatchObject({
      statusCode: 502,
      type: "o1_code_image_attachment_desync",
    })
  })
})

describe("WPP token pill settlement", () => {
  test("reads the current response tag aria-label and chooses the newest pill", () => {
    const element = (value: string) => ({
      textContent: value,
      getAttribute: (name: string) => (name === "aria-label" ? `${value} tokens` : null),
      getBoundingClientRect: () => ({ width: 40, height: 16 }),
      querySelectorAll: () => [],
    })

    expect(harness.pickTokenPill([element("3,891"), element("4,120")])).toMatchObject({
      value: 4120,
      text: "4,120 tokens",
    })
  })

  test("rejects the unchanged network-complete pill and accepts its delayed update", async () => {
    const values = [
      { totalTokens: 100, source: "dom-pill", scope: "context", fidelity: "confirmed" },
      { totalTokens: 125, source: "dom-pill", scope: "context", fidelity: "confirmed" },
    ]

    const result = await harness.waitForUpdatedTokenPill(
      { totalTokens: 100 },
      {
        read: () => values.shift() ?? null,
        sleep: async () => {},
        timeoutMs: 10,
        pollMs: 1,
      },
    )

    expect(result.measurement).toMatchObject({ totalTokens: 125, source: "dom-pill", fidelity: "confirmed" })
    expect(result.observation).toMatchObject({ before: 100, networkComplete: 100, settled: 125 })
  })

  test("returns no measurement when the pill never changes", async () => {
    const result = await harness.waitForUpdatedTokenPill(
      { totalTokens: 100 },
      {
        read: () => ({ totalTokens: 100, source: "dom-pill", scope: "context", fidelity: "confirmed" }),
        sleep: async () => {},
        timeoutMs: 0,
        pollMs: 1,
      },
    )

    expect(result.measurement).toBeNull()
    expect(result.observation).toMatchObject({ before: 100, networkComplete: 100, settled: 100 })
  })
})

async function loadContentHarness(): Promise<ContentHarness> {
  const source = await Bun.file(join(import.meta.dir, "injected", "content.js")).text()
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const timers = new Map<number, () => void>()
  let timerId = 0

  const window = {
    addEventListener(name: string, listener: (...args: unknown[]) => void) {
      listeners.set(name, listener)
    },
    postMessage() {},
    __o1CodeRecorderControl() {},
  }

  const context = vm.createContext({
    window,
    document: { querySelectorAll: () => [] },
    location: { hostname: "open-web-assistant-cs.wpp.ai", href: "https://open-web-assistant-cs.wpp.ai/" },
    process: { versions: { node: "test" } },
    __O1_CODE_BRIDGE_TEST_HOOKS__: true,
    URL,
    Date,
    Math,
    Map,
    Set,
    Error,
    Promise,
    crypto,
    setTimeout: (callback: () => void) => {
      timers.set(++timerId, callback)
      return timerId
    },
    clearTimeout: (id: number) => timers.delete(id),
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
  })

  vm.runInContext(
    source.replace(
      /\}\)\(\);?\s*$/u,
      "globalThis.__o1CodeBridgeContentTest.waitForNetworkResponse = waitForNetworkResponse;\n})();",
    ),
    context,
  )
  const value: unknown = vm.runInContext("__o1CodeBridgeContentTest", context)

  if (!isContentHarness(value)) throw new Error("Content test harness was not installed")

  return {
    ...value,
    timers,
    deliver: (record) =>
      listeners.get("message")?.({
        source: window,
        data: { source: "o1-code-bridge-page", type: "O1_CODE_BRIDGE_NETWORK_RECORD", record },
      }),
  }
}

function isContentHarness(value: unknown): value is ContentHarness {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof Reflect.get(value, "imageAttachmentDesync") === "function" &&
      typeof Reflect.get(value, "pickTokenPill") === "function" &&
      typeof Reflect.get(value, "waitForUpdatedTokenPill") === "function",
  )
}
