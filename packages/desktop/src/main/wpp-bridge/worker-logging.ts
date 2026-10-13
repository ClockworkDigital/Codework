import type { EventEmitter } from "node:events"
import { redact } from "./proxy/policy.mjs"

export type WorkerLogWriter = (
  workerId: number,
  event: string,
  details: Record<string, unknown>,
  level?: "info" | "warn" | "error",
) => void

const observed = new WeakSet<object>()
let writer: WorkerLogWriter = () => {}

export function setWorkerLogWriter(value: WorkerLogWriter) {
  writer = value
}

export function writeWorkerLog(
  workerId: number,
  event: string,
  details: Record<string, unknown>,
  level: "info" | "warn" | "error" = "info",
  sink = writer,
) {
  // Diagnostics must never change worker settlement if a log transport fails.
  try {
    sink(workerId, event, redact(details), level)
  } catch {
    return
  }
}

export function isLoggedWorker(contents: object) {
  return observed.has(contents)
}

export function diagnosticUrl(value: string) {
  const url = URL.parse(value)
  return url ? `${url.origin === "null" ? url.protocol : url.origin}${url.pathname}`.slice(0, 512) : "unknown"
}

export function observeWorkerWindow(
  contents: EventEmitter & { getURL(): string; debugger: EventEmitter },
  record: (event: string, details: Record<string, unknown>, level?: "info" | "warn" | "error") => void,
) {
  observed.add(contents)
  contents.on(
    "console-message",
    (
      event: { message?: string; level?: string; lineNumber?: number; sourceId?: string },
      ...legacy: [number?, string?, number?, string?]
    ) => {
      const params =
        event.message !== undefined
          ? event
          : {
              level: ["debug", "info", "warning", "error"][legacy[0] ?? 1],
              message: legacy[1],
              lineNumber: legacy[2],
              sourceId: legacy[3],
            }
      if (typeof params.message !== "string") return
      // Recorder status is logged through its structured callback, not duplicated as console prose.
      if (params.message.startsWith("__wppRecorderProbe:")) return
      record(
        "console",
        {
          severity: params.level,
          source: diagnosticUrl(params.sourceId ?? ""),
          line: params.lineNumber,
          messageChars: params.message.length,
          ...(process.env.O1_CODE_PROXY_LOG_PAYLOADS === "1" ? { message: params.message.slice(0, 2000) } : {}),
        },
        params.level === "error" ? "error" : params.level === "warning" ? "warn" : "info",
      )
    },
  )
  contents.on(
    "did-start-navigation",
    (event: { url?: string; isMainFrame?: boolean }, ...legacy: [string?, boolean?, boolean?]) => {
      record("navigation-started", {
        url: diagnosticUrl(event.url ?? legacy[0] ?? ""),
        mainFrame: event.isMainFrame ?? legacy[2],
      })
    },
  )
  contents.on(
    "did-fail-load",
    (_event: unknown, code: number, _description: string, url: string, mainFrame: boolean) => {
      record("navigation-failed", { code, url: diagnosticUrl(url), mainFrame }, "warn")
    },
  )
  contents.on("did-finish-load", () => record("navigation-finished", { url: diagnosticUrl(contents.getURL()) }))
  contents.on("unresponsive", () => record("unresponsive", {}, "warn"))
  contents.on("responsive", () => record("responsive", {}))
  contents.on("render-process-gone", (_event: unknown, details: { reason: string; exitCode: number }) => {
    record("renderer-exited", { reason: details.reason, exitCode: details.exitCode }, "error")
  })
  contents.debugger.on("detach", (_event: unknown, reason: string) => record("debugger-detached", { reason }, "warn"))
  contents.once("destroyed", () => record("window-destroyed", {}))
}
