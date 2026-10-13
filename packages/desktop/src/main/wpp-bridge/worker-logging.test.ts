import { afterEach, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { diagnosticUrl, isLoggedWorker, observeWorkerWindow, writeWorkerLog } from "./worker-logging"

const previousPayloads = process.env.O1_CODE_PROXY_LOG_PAYLOADS
afterEach(() => {
  if (previousPayloads === undefined) delete process.env.O1_CODE_PROXY_LOG_PAYLOADS
  else process.env.O1_CODE_PROXY_LOG_PAYLOADS = previousPayloads
})

function observedWindow() {
  const contents = Object.assign(new EventEmitter(), {
    getURL: () => "https://wpp.test/chat?token=private#secret",
    debugger: new EventEmitter(),
  })
  const records: { event: string; details: Record<string, unknown>; level?: string }[] = []
  observeWorkerWindow(contents, (event, details, level) => {
    writeWorkerLog(7, event, details, level, (_id, event, details, level) => records.push({ event, details, level }))
  })
  return { contents, records }
}

test("worker console metadata excludes page content by default with modern and legacy events", () => {
  process.env.O1_CODE_PROXY_LOG_PAYLOADS = "0"
  const window = observedWindow()
  expect(isLoggedWorker(window.contents)).toBe(true)
  window.contents.emit("console-message", {
    message: "private prompt and response",
    level: "error",
    sourceId: "https://user:password@wpp.test/code.js?token=private#secret",
    lineNumber: 42,
  })
  window.contents.emit(
    "console-message",
    {},
    2,
    "private legacy message",
    43,
    "https://wpp.test/code.js?secret=private",
  )
  expect(window.records).toHaveLength(2)
  expect(window.records[0]).toEqual({
    event: "console",
    level: "error",
    details: { severity: "error", source: "https://wpp.test/code.js", line: 42, messageChars: 27 },
  })
  expect(window.records[1].level).toBe("warn")
  expect(JSON.stringify(window.records)).not.toContain("private")
})

test("opted-in console payloads are bounded and redact credentials", () => {
  process.env.O1_CODE_PROXY_LOG_PAYLOADS = "1"
  const window = observedWindow()
  window.contents.emit("console-message", {
    message: `Bearer private-secret ${"x".repeat(4000)}`,
    level: "info",
    sourceId: "https://wpp.test/",
  })
  expect(window.records[0].details.message).toStartWith("Bearer [redacted]")
  expect(String(window.records[0].details.message).length).toBeLessThanOrEqual(2000)
  expect(JSON.stringify(window.records)).not.toContain("private-secret")
})

test("navigation, renderer exits and debugger detachment are logged without URL secrets", () => {
  const window = observedWindow()
  window.contents.emit("did-start-navigation", {}, "https://wpp.test/chat?token=private#secret", false, true)
  window.contents.emit(
    "did-fail-load",
    {},
    -105,
    "private error description",
    "https://wpp.test/chat?token=private",
    true,
  )
  window.contents.emit("did-finish-load")
  window.contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 9 })
  window.contents.debugger.emit("detach", {}, "target closed")
  window.contents.emit("destroyed")
  expect(window.records.map((record) => record.event)).toEqual([
    "navigation-started",
    "navigation-failed",
    "navigation-finished",
    "renderer-exited",
    "debugger-detached",
    "window-destroyed",
  ])
  expect(window.records[3].details).toEqual({ reason: "crashed", exitCode: 9 })
  expect(JSON.stringify(window.records)).not.toContain("private")
  expect(diagnosticUrl("invalid-url")).toBe("unknown")
})

test("logging transport failures cannot interrupt a worker", () => {
  expect(() =>
    writeWorkerLog(7, "job-started", {}, "info", () => {
      throw new Error("disk full")
    }),
  ).not.toThrow()
})
