import type { Plugin } from "@opencode/plugin"
import { ipcPort } from "./port"
import { BrowserRpc } from "./rpc"
import { failure, parseBrowserIpcRequest, parseBrowserIpcCancel, parseBrowserIpcResult } from "./protocol"

export async function rpcPort(ctx: Plugin.Context) {
  const listeners = new Set<(event: { data: unknown }) => void>()
  let connection: string | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  const disconnect = () => {
    clearTimeout(timeout)
    connection = undefined
    transport.disconnect()
  }
  const parent = {
    on(_event: "message", listener: (event: { data: unknown }) => void) {
      listeners.add(listener)
    },
    off(_event: "message", listener: (event: { data: unknown }) => void) {
      listeners.delete(listener)
    },
    postMessage(message: unknown) {
      const request = parseBrowserIpcRequest(message) ?? parseBrowserIpcCancel(message)
      if (!request) throw new Error("Invalid CM Browser request")
      if (!connection) {
        if (request.type === "browser_request")
          listeners.forEach((receive) =>
            receive({
              data: {
                type: "browser_result",
                id: request.id,
                response: failure("unavailable", "Open this task's CM Browser panel in CookieMonster."),
              },
            }),
          )
        return
      }
      void rpc.events.emit("request", { connectionID: connection, message: JSON.stringify(request) }).catch(disconnect)
    },
  }
  const transport = ipcPort(parent)
  const rpc = await ctx.rpc.register(BrowserRpc, {
    async attach(input) {
      if (connection && connection !== input.connectionID) throw new Error("CM Browser already attached")
      connection = input.connectionID
      clearTimeout(timeout)
      // HTTP cancellation alone cannot release a crashed desktop's attachment.
      timeout = setTimeout(disconnect, 30_000)
      timeout.unref()
      await rpc.events.emit("attached", { connectionID: input.connectionID })
      return null
    },
    async detach(input) {
      if (connection === input.connectionID) disconnect()
      return null
    },
    async result(input) {
      if (input.connectionID !== connection) throw new Error("CM Browser attachment is no longer active")
      const parsed: unknown = JSON.parse(input.message)
      const result = parseBrowserIpcResult(parsed)
      if (!result) throw new Error("Invalid CM Browser result")
      listeners.forEach((receive) => receive({ data: result }))
      return null
    },
  })
  return {
    port: transport,
    close: () => {
      disconnect()
      return rpc.dispose()
    },
  }
}
