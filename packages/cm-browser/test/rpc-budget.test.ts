import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { OpenCode } from "@opencode/sdk"
import { Plugin } from "@opencode/plugin"
import { BrowserRpc } from "../src/rpc"
import { MAX_REQUEST_BYTES, MAX_TYPED_TEXT } from "../src/protocol"

test("the real RPC event boundary rejects oversized serialized browser requests in UTF-8 bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cm-browser-budget-"))
  const ready = Promise.withResolvers<(message: string) => Promise<void>>()
  try {
    await using host = await OpenCode.create({
      config: { directory, project: false, content: "{}" },
      models: { fetch: false },
      fs: { filewatcher: false },
      plugins: [
        Plugin.define({
          id: "browser-budget",
          async setup(ctx) {
            const rpc = await ctx.rpc.register(BrowserRpc, {
              attach: async () => null,
              detach: async () => null,
              result: async () => null,
            })
            if (ctx.location.directory === directory)
              ready.resolve((message) =>
                rpc.events.emit("request", { connectionID: "00000000-0000-4000-8000-000000000001", message }),
              )
            return rpc.dispose
          },
        }),
      ],
    })
    await host.model.list({ location: { directory } })
    const emit = await ready.promise
    const fill = JSON.stringify({
      type: "browser_request",
      id: "one",
      sessionID: "task",
      request: { op: "fill", tabID: "tab", ref: "element", text: "界".repeat(MAX_TYPED_TEXT) },
    })
    await expect(emit(fill)).resolves.toBeUndefined()
    await expect(emit("x".repeat(MAX_REQUEST_BYTES))).resolves.toBeUndefined()
    for (const message of [
      "x".repeat(MAX_REQUEST_BYTES + 1),
      "界".repeat(Math.ceil(MAX_REQUEST_BYTES / 3)),
      JSON.stringify({
        type: "browser_request",
        id: "one",
        sessionID: "task",
        request: { op: "list_tabs" },
        unused: "x".repeat(1024 * 1024),
      }),
    ]) {
      const rejected = await emit(message).then(
        () => false,
        () => true,
      )
      expect(rejected).toBe(true)
    }
    await expect(emit(fill)).resolves.toBeUndefined()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)
