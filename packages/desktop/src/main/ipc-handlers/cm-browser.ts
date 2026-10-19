import { wpp } from "#cm-wpp"
import { BrowserWindow } from "electron"
import { Effect } from "effect"
import { CmBrowserRpcs } from "../../shared/ipc-rpc/cm-browser"
import { IpcPortHandoff } from "../ipc-transport"
import { sender, type RpcContext } from "./context"
import { isRendererUrl } from "../windows/scheme"

export const cmBrowserHandlers = CmBrowserRpcs.toLayer(
  Effect.gen(function* () {
    const handoff = yield* IpcPortHandoff

    const owner = async (context: RpcContext) => {
      const contents = sender(handoff, context)
      const win = BrowserWindow.fromWebContents(contents)

      if (
        !import.meta.env.CM_BRAND ||
        !win ||
        win.isDestroyed() ||
        win.webContents !== contents ||
        !isRendererUrl(contents.getURL())
      )
        throw new Error("Invalid CM Browser caller")
      const api = await import("../browser/tabs")

      return { api, current: api.registerBrowserOwner(win) }
    }

    return CmBrowserRpcs.of({
      CmBrowserCommand: (input, context) =>
        Effect.promise(async () => {
          const { api, current } = await owner(context)
          const { connectBrowser } = await import("../browser/v2-channel")
          await connectBrowser(input.sessionID)
          const command: unknown = JSON.parse(input.command)

          return JSON.stringify(await api.browserCommand(current, input.sessionID, command))
        }),
      CmBrowserViewport: (input, context) =>
        Effect.promise(async () => {
          const { api, current } = await owner(context)
          const viewport: unknown = JSON.parse(input.viewport)
          // The native boundary validates the bounds and owner lease.
          api.browserViewport(current, viewport as Parameters<typeof api.browserViewport>[1])
        }),
      CmBrowserContext: (input, context) =>
        Effect.promise(async () => {
          const { api, current } = await owner(context)

          return (
            JSON.stringify(await api.browserPageContext(current, input.sessionID, input.tabID, input.operation)) ??
            "null"
          )
        }),
      CmBrowserPanelCurrent: (input, context) =>
        Effect.promise(async () => {
          const { api, current } = await owner(context)

          return api.browserPanelRequestCurrent(current, input.id, input.sessionID)
        }),
      CmBrowserPanelAcknowledge: (input, context) =>
        Effect.promise(async () => {
          const { api, current } = await owner(context)

          return api.browserPanelAcknowledgement(current, JSON.parse(input.acknowledgement))
        }),
      CmBrowserLinkContext: (input, context) =>
        Effect.promise(async () => {
          const { api, current } = await owner(context)
          api.browserLinkContext(current, input.sessionID, input.lease)
        }),
      CmWppAuth: (input, context) =>
        Effect.promise(async () => {
          await owner(context)
          if (!wpp) throw new Error("wpp_unavailable")

          return JSON.stringify(input.check ? await wpp.auth.check() : wpp.auth.get())
        }),
      CmWppLogin: (_input, context) =>
        Effect.promise(async () => {
          await owner(context)
          if (!wpp) throw new Error("wpp_unavailable")
          wpp.toggleLogin()
        }),
    })
  }),
)
