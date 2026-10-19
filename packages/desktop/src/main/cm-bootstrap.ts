import { existsSync } from "node:fs"
import path from "node:path"
import { app, BrowserWindow } from "electron"
import { wpp } from "#cm-wpp"
import { getStore } from "./storage/store"
import { cookieMonsterConfig } from "./cm-config"
import { resolveCmAePlugin } from "../cm-ae"

export async function startCookieMonster() {
  process.env.CM_DESKTOP = "1"
  const ae = resolveCmAePlugin({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    version: app.getVersion(),
    warn: console.warn,
  })
  if (ae) {
    process.env.CM_AE_PLUGIN_URL = ae[0]
    process.env.CM_AE_VERSION = app.getVersion()
  }

  const entries = app.isPackaged
    ? [
        ...(wpp ? [path.join(process.resourcesPath, "cm-plugins/provider")] : []),
        path.join(process.resourcesPath, "cm-plugins/figma"),
        path.join(process.resourcesPath, "cm-plugins/browser"),
      ]
    : [
        ...(wpp ? [path.join(app.getAppPath(), "wpp/node_modules/@cookiemonster/wpp/provider")] : []),
        path.join(app.getAppPath(), "../plugins/figma"),
        path.join(app.getAppPath(), "../cm-browser"),
      ]

  entries.forEach((file) => {
    if (!existsSync(file)) throw new Error(`CookieMonster plugin is missing: ${file}`)
  })
  process.env.OPENCODE_CONFIG_CONTENT = cookieMonsterConfig(entries, process.env.OPENCODE_CONFIG_CONTENT, wpp?.model)
  if (wpp) {
    await wpp.start(getStore().get("wppChatMode") === "agent" ? "agent" : "assistant", (state) =>
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) win.webContents.send("cm-wpp-auth", state)
      }),
    )
  }
}
