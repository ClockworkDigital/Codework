import { contextBridge, ipcRenderer, webUtils } from "electron"
import {
  DragCancelEvent,
  IpcTransportPort,
  WindowSnapshotChannel,
  storageSnapshotNames,
  type WindowSnapshot,
} from "../shared/ipc-transport"
import { windowBootstrapFromArguments } from "../shared/window-bootstrap"
import type { ElectronNative } from "./types"
import type { WppAuthState } from "../shared/wpp-auth"
import type { BrowserPanelPlatform } from "@cookiemonster/cm-browser/panel"

function subscribe<Value>(channel: string, callback: (value: Value) => void) {
  const receive = (_event: unknown, value: Value) => callback(value)
  ipcRenderer.on(channel, receive)

  return () => {
    ipcRenderer.removeListener(channel, receive)
  }
}

const cmBrowserEvents: Pick<
  BrowserPanelPlatform,
  "subscribe" | "onShortcut" | "onOpened" | "onPanelRequest" | "onPanelCancel"
> = {
  subscribe: (callback) => subscribe("browser-tabs", callback),
  onShortcut: (callback) => subscribe("browser-shortcut", callback),
  onOpened: (callback) => subscribe("browser-opened", callback),
  onPanelRequest: (callback) => subscribe("desktop-panel-request", callback),
  onPanelCancel: (callback) => subscribe("desktop-panel-cancel", callback),
}

ipcRenderer.on(IpcTransportPort, (event) => {
  const port = event.ports[0]

  if (port) window.postMessage(IpcTransportPort, "*", [port])
})

ipcRenderer.on(DragCancelEvent, () => window.dispatchEvent(new Event(DragCancelEvent)))

const bootstrap = windowBootstrapFromArguments(process.argv)

// Asked before the page runs, so the stores the shell reads are hydrated on the first render.
const snapshot: Promise<WindowSnapshot> = ipcRenderer
  .invoke(WindowSnapshotChannel, storageSnapshotNames(bootstrap.id))
  .catch(() => ({ storage: {} }))

contextBridge.exposeInMainWorld("electron", {
  onWppAuth: (callback: (state: WppAuthState) => void) => subscribe("cm-wpp-auth", callback),
  cmBrowserEvents,
  windowID: bootstrap.id,
  bootstrap,
  storageSnapshot: snapshot.then((snapshot) => snapshot.storage),
  extensions: snapshot.then((snapshot) => snapshot.extensions),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
} satisfies ElectronNative)
