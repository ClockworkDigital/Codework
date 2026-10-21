import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { success, type BrowserIpcResult, type PanelRequest } from "@cookiemonster/cm-browser/protocol"
import { attachBrowserBridge } from "./bridge"
import { setBrowserAgentEnabled, setBrowserPanelHandler, setBrowserTaskPaused } from "./registry"

test("ordinary bridge authority reaches the panel owner while paused and disabled tasks remain denied", async () => {
  const replies: BrowserIpcResult[] = []
  const calls: { sessionID: string; request: PanelRequest }[] = []
  const child = Object.assign(new EventEmitter(), { postMessage: (reply: BrowserIpcResult) => replies.push(reply) })
  setBrowserAgentEnabled(true)
  setBrowserPanelHandler(async (sessionID, request) => {
    calls.push({ sessionID, request })

    return success({
      tabID: "",
      url: "",
      title: "",
      visibleText: "",
      elements: [],
      panelResult:
        request.view === "browser"
          ? { view: "browser", tabID: request.tabID, browserReady: true }
          : { view: request.view, browserReady: false },
    })
  })
  const stop = attachBrowserBridge(child)

  const requests: PanelRequest[] = [
    { op: "set_panel", view: "review" },
    { op: "set_panel", view: "hidden" },
    { op: "set_panel", view: "browser", tabID: "authorized-tab" },
  ]

  try {
    for (const request of requests) {
      child.emit("message", { type: "browser_request", id: String(replies.length), sessionID: "panel-owner", request })
      await new Promise((resolve) => setImmediate(resolve))
      expect(replies.at(-1)?.response.ok).toBe(true)
      expect(calls.at(-1)).toEqual({ sessionID: "panel-owner", request })
    }

    setBrowserTaskPaused("panel-owner", true)
    child.emit("message", { type: "browser_request", id: "paused", sessionID: "panel-owner", request: requests[0] })
    await new Promise((resolve) => setImmediate(resolve))
    expect(replies.at(-1)?.response).toMatchObject({ ok: false, code: "access_denied" })
    setBrowserTaskPaused("panel-owner", false)
    setBrowserAgentEnabled(false)
    child.emit("message", { type: "browser_request", id: "disabled", sessionID: "panel-owner", request: requests[0] })
    await new Promise((resolve) => setImmediate(resolve))
    expect(replies.at(-1)?.response).toMatchObject({ ok: false, code: "access_denied" })
    expect(calls).toHaveLength(3)
  } finally {
    stop()
    setBrowserAgentEnabled(true)
    setBrowserTaskPaused("panel-owner", false)
    setBrowserPanelHandler(undefined)
  }
})
