import { createStore } from "solid-js/store"
import type { WppAuthState } from "../../shared/wpp-auth"
import type { Platform } from "@opencode/app/desktop"
import type { ElectronAPI } from "../api-types"
import { setPinchZoomEnabled, webviewZoom } from "../window/zoom"
import { windowFullscreen } from "../window/fullscreen"
import { DragCancelEvent } from "../../shared/ipc-transport"
import { createExtensionBridge } from "../extensions"
import { createDesktopFiles } from "./files"
import { createDesktopMenuAction } from "./menu"
import { createDesktopNotify } from "./notifications"
import { createDesktopStorage } from "./storage"

export type DesktopWindowState = {
  id: string
  version: string
}

export function createDesktopPlatform(api: ElectronAPI, windowState: DesktopWindowState): Platform {
  const os = desktopOS()
  const [auth, setAuth] = createStore<WppAuthState>({ status: "unknown", checkedAt: null, loginVisible: false })

  if (import.meta.env.CM_BRAND && import.meta.env.CM_WPP) {
    window.addEventListener("unload", api.onWppAuth(setAuth), { once: true })
    void api
      .wppAuth(false)
      .then(setAuth)
      .catch(() => undefined)
  }

  return {
    platform: "desktop",
    os,
    version: windowState.version,
    windowID: windowState.id,
    ...(import.meta.env.CM_BRAND
      ? {
          browserPanel: api.browserPanel,
        }
      : {}),
    ...(import.meta.env.CM_BRAND && import.meta.env.CM_WPP
      ? {
          wppLogin: api.wppLogin,
          wppAuth: { state: () => auth, check: () => api.wppAuth(true), toggleLogin: api.wppLogin },
        }
      : {}),
    ...createDesktopFiles(api, os),
    ...createDesktopStorage(api),
    exportDebugLogs: () => api.exportDebugLogs(),
    setForceFocus: (enabled) => api.setForceFocus(enabled),
    recordFatalRendererError: (error) => api.recordFatalRendererError(error),
    restart: async () => api.relaunch(),
    notify: createDesktopNotify(api),
    fetch: (input, init) => {
      if (input instanceof Request) return fetch(input)

      return fetch(input, init)
    },
    webviewZoom,
    windowFullscreen,
    getPinchZoomEnabled: () => api.getPinchZoomEnabled(),
    setPinchZoomEnabled,
    onDragCancel: (callback) => {
      window.addEventListener(DragCancelEvent, callback)

      return () => window.removeEventListener(DragCancelEvent, callback)
    },
    runDesktopMenuAction: createDesktopMenuAction(api),
    checkAppExists: async (appName) => {
      return api.checkAppExists(appName)
    },
    extensions: createExtensionBridge(),
  }
}

function desktopOS() {
  if (navigator.userAgent.includes("Mac")) return "macos"

  if (navigator.userAgent.includes("Windows")) return "windows"

  if (navigator.userAgent.includes("Linux")) return "linux"

  return undefined
}
