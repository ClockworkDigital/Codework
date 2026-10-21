import type { BrowserWindow, Session, WebContents } from "electron"
import { SidecarCredentials } from "../service/sidecar-credentials"
import { addRendererHeaders, hasHeader, upsertHeader } from "./headers"
import { isRendererUrl } from "./scheme"

const rendererPermissions = new Set(["clipboard-sanitized-write", "notifications"])

const rendererWindows = new WeakMap<Session, Set<WebContents>>()

export function allowRendererPermissions(win: BrowserWindow) {
  const contents = win.webContents
  const session = contents.session
  const registered = rendererWindows.get(session) ?? new Set<WebContents>()

  if (registered.has(contents)) return
  registered.add(contents)
  contents.once("destroyed", () => registered.delete(contents))

  if (rendererWindows.has(session)) return
  rendererWindows.set(session, registered)

  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(
      rendererPermissions.has(permission) &&
        registered.has(webContents) &&
        !webContents.isDestroyed() &&
        details.isMainFrame &&
        isRendererUrl(details.requestingUrl),
    )
  })
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (!rendererPermissions.has(permission) || !webContents || !registered.has(webContents)) return false

    if (webContents.isDestroyed() || !details.isMainFrame) return false

    return isRendererUrl(details.requestingUrl) || isRendererUrl(requestingOrigin)
  })
}

export function wireNavigationPolicy(win: BrowserWindow, openExternalURL: (url: string) => void) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isRendererUrl(url)) openExternalURL(url)

    return { action: "deny" }
  })
  win.webContents.on("will-navigate", (event, url) => {
    if (isRendererUrl(url)) return
    event.preventDefault()
    openExternalURL(url)
  })
}

export function wireRendererHeaders(win: BrowserWindow) {
  // The renderer sends sidecar requests without credentials, so its GETs are CORS-simple and need no
  // preflight. Electron applies these listeners in Chromium's extraHeaders mode, after the CORS
  // decision, so adding Authorization here does not reintroduce one.
  //
  // Only the renderer's own top-level frame is credentialed. Other content in this session (web views,
  // embedded pages) can reach the same loopback origin and must not inherit its access. Requests with
  // no frame, such as from a service worker, are not credentialed either; the renderer registers none.
  win.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ["http://127.0.0.1/*", "http://localhost/*"] },
    (details, callback) => {
      const frame = details.frame
      const renderer = !!frame && frame.parent === null && isRendererUrl(frame.url)
      const authorization = renderer && SidecarCredentials.authorization(SidecarCredentials.get(), details.url)

      if (authorization && !hasHeader(details.requestHeaders, "Authorization")) {
        upsertHeader(details.requestHeaders, "Authorization", authorization)
      }

      callback({ requestHeaders: details.requestHeaders })
    },
  )
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = details.responseHeaders ?? {}
    addRendererHeaders(responseHeaders, { document: isRendererUrl(details.url, true) })
    callback({ responseHeaders })
  })
}
