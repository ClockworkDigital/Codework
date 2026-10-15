import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenCode } from "@opencode/sdk"
import { Plugin, Agent } from "@opencode/plugin"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { CallID } from "@opencode/plugin/promise/tool"
import browser from "../src/plugin"
import { BrowserRpc } from "../src/rpc"
import { rpcPort } from "../src/rpc-port"
import { parseBrowserIpcRequest, success } from "../src/protocol"

test("V2 exposes CM tools directly and keeps user permission rules after lifecycle defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cm-browser-v2-"))
  const captured = Promise.withResolvers<Plugin.Context>()
  try {
    await using host = await OpenCode.create({
      config: {
        directory,
        project: false,
        content: JSON.stringify({
          plugins: ["-opencode.browser"],
          permissions: [
            { action: "*", resource: "*", effect: "ask" },
            { action: "browser_create_tab", resource: "*", effect: "deny" },
          ],
        }),
      },
      models: { fetch: false },
      fs: { filewatcher: false },
      plugins: [
        browser,
        Plugin.define({
          id: "observe",
          setup(ctx) {
            if (ctx.location.directory === directory) captured.resolve(ctx)
          },
        }),
      ],
    })
    await host.model.list({ location: { directory } })
    const agents = await host.agent.list({ location: { directory } })
    const ctx = await captured.promise
    const tools = await ctx.tool.list()
    expect(tools.find((entry) => entry.name === "browser_read_state")?.options?.codemode).toBe(false)
    expect(
      tools.some((entry) => entry.options?.namespace === "browser" || entry.options?.namespace?.startsWith("browser.")),
    ).toBe(false)
    const build = agents.data.find((entry) => entry.name === "Build")!
    expect(build.permissions.slice(0, 4).map((rule) => rule.action)).toEqual([
      "browser_create_tab",
      "browser_select_tab",
      "browser_close_tab",
      "desktop_set_panel",
    ])
    expect(
      build.permissions.filter(
        (rule) =>
          (rule.action === "*" && rule.effect === "ask") ||
          (rule.action === "browser_create_tab" && rule.effect === "deny"),
      ),
    ).toEqual([
      { action: "*", resource: "*", effect: "ask" },
      { action: "browser_create_tab", resource: "*", effect: "deny" },
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)

test("V2 Browser RPC binds one desktop and preserves uncertain action settlement on disconnect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cm-browser-rpc-"))
  const channel = Promise.withResolvers<Awaited<ReturnType<typeof rpcPort>>>()
  const controller = new AbortController()
  try {
    await using host = await OpenCode.create({
      config: { directory, project: false, content: "{}" },
      models: { fetch: false },
      fs: { filewatcher: false },
      plugins: [
        Plugin.define({
          id: "browser-rpc",
          async setup(ctx) {
            const value = await rpcPort(ctx)
            if (ctx.location.directory === directory) channel.resolve(value)
            return value.close
          },
        }),
      ],
    })
    await host.model.list({ location: { directory } })

    const { port } = await channel.promise

    expect(await port.send("session", { op: "list_tabs" })).toMatchObject({ ok: false, code: "unavailable" })
    const rpc = host.rpc(BrowserRpc)
    const connectionID = crypto.randomUUID()
    const attached = Promise.withResolvers<void>()
    rpc.events.on("attached", () => attached.resolve(), { signal: controller.signal })
    const stream = host.events.subscribe({ signal: controller.signal })[Symbol.asyncIterator]()
    expect((await stream.next()).value?.type).toBe("server.connected")
    const attachment = rpc
      .attach({ connectionID }, { location: { directory }, signal: controller.signal })
      .catch(() => null)
    await attached.promise

    await expect(rpc.attach({ connectionID: crypto.randomUUID() }, { location: { directory } })).rejects.toMatchObject({
      type: "rpc.internal",
    })
    const received = Promise.withResolvers<string>()
    rpc.events.on(
      "request",
      async (event) => {
        const parsed: unknown = JSON.parse(event.data.message)
        const request = parseBrowserIpcRequest(parsed)

        if (!request) return
        if (request.request.op !== "list_tabs") {
          received.resolve(request.id)
          return
        }
        await rpc.result(
          {
            connectionID,
            message: JSON.stringify({
              type: "browser_result",
              id: request.id,
              response: success({ tabID: "", url: "", title: "", elements: [], tabs: [] }),
            }),
          },
          { location: { directory } },
        )
      },
      { signal: controller.signal },
    )
    expect(await port.send("session", { op: "list_tabs" })).toMatchObject({ ok: true, result: { tabs: [] } })
    const pending = port.send("session", {
      op: "navigate",
      tabID: "tab",
      url: "https://example.com",
      context: {
        tabID: "tab",
        origin: "https://example.com",
        urlHash: "a".repeat(64),
        revision: 1,
        accessRevision: 1,
        ownerContext: "owner",
      },
    })

    await received.promise

    await rpc.detach({ connectionID }, { location: { directory } })
    controller.abort()

    await attachment
    expect(await pending).toMatchObject({
      ok: false,
      code: "unavailable",
      actionStatus: "dispatched_uncertain",
      actionCause: "transport_unknown",
    })
    await stream.return?.()
  } finally {
    controller.abort()
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)

test("a subagent cannot admit its prompt when native browser delegation fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cm-subagent-v2-"))
  const captured = Promise.withResolvers<Plugin.Context>()
  try {
    await using host = await OpenCode.create({
      config: {
        directory,
        project: false,
        content: JSON.stringify({
          plugins: ["-opencode.browser"],
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
        }),
      },
      models: { fetch: false },
      fs: { filewatcher: false },
      plugins: [
        browser,
        Plugin.define({
          id: "observe",
          setup(ctx) {
            if (ctx.location.directory === directory) captured.resolve(ctx)
          },
        }),
      ],
    })
    await host.model.list({ location: { directory } })
    const ctx = await captured.promise
    const parent = await host.sessions.create({ title: "Delegation parent", location: { directory } })
    const tool = (await ctx.tool.list()).find((tool) => tool.name === "subagent")!
    await expect(
      tool.execute(
        { agent: "general", description: "Browser child", prompt: "Read the tab", browser_tab_ids: ["tab"] },
        {
          sessionID: Session.ID.make(parent.id),
          agent: Agent.ID.make("build"),
          messageID: SessionMessage.ID.create(),
          id: CallID.make("delegate"),
          signal: AbortSignal.timeout(5000),
          progress: async () => {},
        },
      ),
    ).rejects.toThrow("Browser delegation failed")
    const children = (await host.sessions.list({ parentID: parent.id })).data
    expect(children).toHaveLength(1)
    expect((await host.message.list({ sessionID: children[0].id })).data).toHaveLength(0)
    await expect(
      tool.execute(
        {
          agent: "general",
          description: "Browser child",
          prompt: "Read the tab",
          browser_tab_ids: ["tab"],
          background: true,
        },
        {
          sessionID: Session.ID.make(parent.id),
          agent: Agent.ID.make("build"),
          messageID: SessionMessage.ID.create(),
          id: CallID.make("background"),
          signal: AbortSignal.timeout(5000),
          progress: async () => {},
        },
      ),
    ).rejects.toThrow("new foreground subagent")
    expect((await host.sessions.list({ parentID: parent.id })).data).toHaveLength(1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
