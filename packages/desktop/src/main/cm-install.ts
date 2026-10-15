import { app, dialog } from "electron"
import path from "node:path"
import { nativeT } from "./native-translations"
import { installFromDiskImage } from "./macos-user-install"

export async function installCookieMonster() {
  return installFromDiskImage({
    executable: app.getPath("exe"),
    applications: path.join(app.getPath("home"), "Applications"),
    confirm: async (destination) => {
      const result = await dialog.showMessageBox({
        type: "question",
        title: nativeT("desktop.install.title"),
        message: nativeT("desktop.install.title"),
        detail: nativeT("desktop.install.replaceDetail", { destination }),
        buttons: [nativeT("desktop.install.confirm"), nativeT("desktop.recovery.action.quit")],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })

      return result.response === 0
    },
    manual: async () => {
      await dialog.showMessageBox({
        type: "warning",
        message: nativeT("desktop.install.title"),
        detail: nativeT("desktop.install.replaceManual"),
        buttons: [nativeT("desktop.recovery.action.quit")],
      })
    },
    failed: async (destination) => {
      await dialog.showMessageBox({
        type: "error",
        message: nativeT("desktop.install.title"),
        detail: nativeT("desktop.install.replaceFailed", { destination }),
        buttons: [nativeT("desktop.recovery.action.quit")],
      })
    },
    releaseLock: () => app.releaseSingleInstanceLock(),
    quit: () => app.quit(),
  })
}
