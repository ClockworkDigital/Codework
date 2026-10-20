import { expect, mock, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { BrowserWindow, Session, WebContents } from "electron"
import { allowRendererPermissions } from "./security"

test("session permission handlers cover every live main window and reject other frames and contents", () => {
  const session = {
    setPermissionRequestHandler: mock(
      (_handler: NonNullable<Parameters<Session["setPermissionRequestHandler"]>[0]>) => {},
    ),
    setPermissionCheckHandler: mock((_handler: NonNullable<Parameters<Session["setPermissionCheckHandler"]>[0]>) => {}),
  }

  const first = window(session, 1)
  const second = window(session, 2)
  const unrelated = window(session, 3)
  allowRendererPermissions(first.win)
  allowRendererPermissions(second.win)
  allowRendererPermissions(first.win)
  expect(session.setPermissionRequestHandler).toHaveBeenCalledTimes(1)
  expect(session.setPermissionCheckHandler).toHaveBeenCalledTimes(1)
  const request = session.setPermissionRequestHandler.mock.calls[0][0]
  const check = session.setPermissionCheckHandler.mock.calls[0][0]

  for (const permission of ["notifications", "clipboard-sanitized-write"] as const) {
    for (const [fixture, allowed] of [
      [first, true],
      [second, true],
      [unrelated, false],
    ] as const) {
      const callback = mock((_allowed: boolean) => {})
      request(fixture.contents, permission, callback, { requestingUrl: "oc://renderer/index.html", isMainFrame: true })
      expect(callback).toHaveBeenCalledWith(allowed)
      expect(check(fixture.contents, permission, "oc://renderer", { isMainFrame: true })).toBe(allowed)
    }

    expect(check(null, permission, "oc://renderer", { isMainFrame: true })).toBe(false)
    expect(check(first.contents, permission, "https://untrusted.example", { isMainFrame: true })).toBe(false)
    expect(check(first.contents, permission, "oc://renderer", { isMainFrame: false })).toBe(false)
    const subframe = mock((_allowed: boolean) => {})
    request(first.contents, permission, subframe, { requestingUrl: "oc://renderer/index.html", isMainFrame: false })
    expect(subframe).toHaveBeenCalledWith(false)
  }

  expect(check(first.contents, "media", "oc://renderer", { isMainFrame: true })).toBe(false)
  second.close()
  expect(check(second.contents, "notifications", "oc://renderer", { isMainFrame: true })).toBe(false)
  expect(check(first.contents, "notifications", "oc://renderer", { isMainFrame: true })).toBe(true)
  first.close()
  expect(check(first.contents, "notifications", "oc://renderer", { isMainFrame: true })).toBe(false)
})

function window(session: Pick<Session, "setPermissionRequestHandler" | "setPermissionCheckHandler">, id: number) {
  const state = { destroyed: false }
  const contents = Object.assign(new EventEmitter(), { id, session, isDestroyed: () => state.destroyed })

  // SAFETY: This fixture owns these native stand-ins. The handler reads session, lifetime, and event methods only.
  return {
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- native stand-in, see SAFETY above
    win: { webContents: contents } as unknown as BrowserWindow,
    // SAFETY: This same owned object supplies lifetime, identity and session; it is never passed to Electron.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions
    contents: contents as unknown as WebContents,
    close() {
      state.destroyed = true
      contents.emit("destroyed")
    },
  }
}
