import type { WppAuthState } from "@cookiemonster/provider/auth"
import type { StorageSnapshot, WindowSnapshot } from "../shared/ipc-transport"
import type { WindowBootstrap } from "../shared/window-bootstrap"
import type { BrowserPanelPlatform } from "@cookiemonster/cm-browser/panel"

export type ElectronNative = {
  onWppAuth(callback: (state: WppAuthState) => void): () => void
  cmBrowserEvents: Pick<
    BrowserPanelPlatform,
    "subscribe" | "onShortcut" | "onOpened" | "onPanelRequest" | "onPanelCancel"
  >
  windowID: string
  bootstrap: WindowBootstrap
  storageSnapshot: Promise<StorageSnapshot>
  extensions: Promise<WindowSnapshot["extensions"]>
  getPathForFile(file: File): string
}
