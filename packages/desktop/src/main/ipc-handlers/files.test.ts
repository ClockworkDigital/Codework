// SAFETY: This fixture owns its synthetic renderer port, sender and launcher; partial shapes stand in for Electron's
// and child_process's.
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import childProcess, { type ExecFileOptions } from "node:child_process"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import { MessageChannel } from "node:worker_threads"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { createDesktopNativeBundle, DESKTOP_NATIVE_ENGLISH } from "@opencode/app/i18n/desktop-native"
import { shell, type MessagePortMain, type WebContents } from "electron"
import { Layer, ManagedRuntime, Predicate } from "effect"
import { RpcServer, type RpcMessage } from "effect/rpc"
import { nativeT, setNativeTranslations } from "../native/translations"

// Bun module mocks persist across files; isolate the process launcher from the desktop suite.
if (process.env.CM_OPEN_PATH_TEST_CHILD !== "1") {
  test("FilesOpenPath launches only the applications main allows", () => {
    const result = Bun.spawnSync([process.execPath, "test", "--preload", "./test/preload.ts", import.meta.path], {
      cwd: join(import.meta.dir, "../../.."),
      // No usable PATH, so a launch that misses the mock fails instead of opening an installed editor.
      env: { ...process.env, CM_OPEN_PATH_TEST_CHILD: "1", PATH: "/nonexistent" },
      timeout: 15_000,
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode, Buffer.concat([result.stdout, result.stderr]).toString()).toBe(0)
  }, 20_000)
} else {
  const launches: string[][] = []
  const execFile = mock(launch)
  mock.module("node:child_process", () => ({ ...childProcess, execFile }))
  // electron-log's main entry runs its renderer preload on import, which needs a renderer global. Nothing here logs
  // through it.
  mock.module("electron-log/main.js", () => ({ default: {} }))
  const { FileRpcs } = await import("../../shared/ipc-rpc")
  const { DesktopFiles } = await import("../files")
  const { IpcPortHandoff, IpcServerProtocolLive } = await import("../ipc-transport")
  const { fileHandlers } = await import("./files")

  // The renderer pushes the app's language to main. No message here equals its English, so a rejection that main
  // hardcodes instead of translating fails.
  setNativeTranslations(createDesktopNativeBundle("de", (key) => `de: ${DESKTOP_NATIVE_ENGLISH[key]}`))

  const runtime = ManagedRuntime.make(
    RpcServer.layer(FileRpcs).pipe(
      Layer.provide(fileHandlers),
      Layer.provide(DesktopFiles.layer),
      Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
      Layer.provideMerge(IpcServerProtocolLive),
    ),
  )

  const handoff = await runtime.runPromise(IpcPortHandoff)
  const channel = new MessageChannel()
  handoff.bind(rendererSender(1), serverPort(channel.port1))
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!
  let nextId = 0

  // Each OS's open-with apps, named as the renderer sends them, and the commands main runs for each.
  const systems = [
    {
      platform: "darwin",
      target: "/Users/dev/project",
      apps: [
        "Visual Studio Code",
        "Cursor",
        "Zed",
        "TextMate",
        "Antigravity",
        "Terminal",
        "iTerm",
        "Ghostty",
        "Warp",
        "Xcode",
        "Android Studio",
        "Sublime Text",
      ],
      launched: (app: string, target: string) => [["open", "-a", app, target]],
    },
    {
      platform: "win32",
      target: "C:\\Users\\dev\\project",
      apps: ["code", "cursor", "zed", "powershell", "Sublime Text"],
      // Main locates the executable itself; the renderer sends only the app's name.
      launched: (app: string, target: string) => [
        ["where", app],
        [`C:\\Apps\\${app}.exe`, target],
      ],
    },
    {
      platform: "linux",
      target: "/home/dev/project",
      apps: ["code", "cursor", "zed", "Sublime Text"],
      launched: (app: string, target: string) => [[app, target]],
    },
  ]

  const notAllowed = "desktop.openWith.error.appNotAllowed" as const
  const notAbsolute = "desktop.openWith.error.notAbsolute" as const

  beforeEach(() => {
    launches.length = 0
    execFile.mockImplementation(launch)
    spyOn(shell, "openPath").mockImplementation(async (target) => {
      launches.push(["shell.openPath", target])

      return ""
    })
  })

  afterEach(() => {
    mock.restore()
    Object.defineProperty(process, "platform", platform)
  })

  afterAll(async () => {
    channel.port2.close()
    await runtime.dispose()
  })

  describe("FilesOpenPath", () => {
    test.each(systems.flatMap((system) => system.apps.map((app) => ({ ...system, app }))))(
      "opens with $app on $platform",
      async (row) => {
        Object.defineProperty(process, "platform", { value: row.platform })

        expect(await openPath({ path: row.target, application: row.app })).toEqual(success(null))
        expect(launches).toEqual(row.launched(row.app, row.target))
      },
    )

    test.each(systems)("opens with the default app on $platform", async (row) => {
      Object.defineProperty(process, "platform", { value: row.platform })

      expect(await openPath({ path: row.target })).toEqual(success(""))
      expect(launches).toEqual([["shell.openPath", row.target]])
    })

    test("opens with the default app when Windows cannot locate an allowed app", async () => {
      Object.defineProperty(process, "platform", { value: "win32" })
      execFile.mockImplementationOnce((file, args, _options, done) => {
        launches.push([file, ...args])
        done?.(new Error("not found"))

        return new childProcess.ChildProcess()
      })

      expect(await openPath({ path: "C:\\Users\\dev\\project", application: "Sublime Text" })).toEqual(success(""))
      expect(launches).toEqual([
        ["where", "Sublime Text"],
        ["shell.openPath", "C:\\Users\\dev\\project"],
      ])
    })

    test.each([
      // Executables, and apps main does not offer on that OS. Windows renderers used to send the resolved path.
      { platform: "linux", path: "/home/dev/project", application: "/bin/sh", error: notAllowed },
      { platform: "linux", path: "/home/dev/project", application: "Terminal", error: notAllowed },
      { platform: "darwin", path: "/Users/dev/project", application: "Calculator", error: notAllowed },
      { platform: "win32", path: "C:\\project", application: "C:\\Windows\\System32\\cmd.exe", error: notAllowed },
      // Targets an app could read as an option, and relative ones.
      { platform: "linux", path: "--help", application: "code", error: notAbsolute },
      { platform: "linux", path: "project", application: "code", error: notAbsolute },
      { platform: "darwin", path: "-W", application: "Terminal", error: notAbsolute },
      { platform: "win32", path: "/Command", application: "powershell", error: notAbsolute },
      { platform: "win32", path: "-NoProfile", application: "powershell", error: notAbsolute },
    ])("rejects $application for $path on $platform", async (row) => {
      Object.defineProperty(process, "platform", { value: row.platform })

      // The renderer rejects with this message, which the open-with menu shows in its toast.
      expect(await openPath({ path: row.path, application: row.application })).toEqual(
        failed(nativeT(row.error, { app: row.application })),
      )
      expect(launches).toEqual([])
    })
  })

  // Stands in for execFile. Main's Windows lookup runs `where` through util.promisify, which resolves with the
  // callback's second argument, so it answers in execFile's promisified shape. Nothing native runs.
  function launch(file: string, args: string[], options: ExecFileOptions | Done, done?: Done) {
    launches.push([file, ...args])
    // SAFETY: execFile's overload supplies either its typed options object or its callback in this slot.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    const callback = typeof options === "function" ? options : done
    callback?.(null, file === "where" ? { stdout: `C:\\Apps\\${args[0]}.exe\r\n`, stderr: "" } : undefined)

    return new childProcess.ChildProcess()
  }

  // SAFETY: this is the RPC wire format's plain encoded request, which the renderer posts as is.
  /* oxlint-disable anti-slop-effect/no-manual-tagged-construction -- see SAFETY above */
  // Posts what src/renderer/ipc-client.ts posts for `api.openPath`, and settles as it does: on this request's exit,
  // or on a defect, which ends every pending request.
  function openPath(payload: RpcMessage.RequestEncoded["payload"]) {
    const id = nextId++

    return new Promise<Settled>((resolve) => {
      const settle = (value: Settled) => {
        channel.port2.off("message", onMessage)
        resolve(value)
      }

      const onMessage = (message: RpcMessage.FromServerEncoded) => {
        if (Predicate.isTagged(message, "Defect")) return settle(message)

        if (!Predicate.isTagged(message, "Exit") || Number(message.requestId) !== id) return
        settle(message.exit)
      }

      channel.port2.on("message", onMessage)
      channel.port2.postMessage({ _tag: "Request", id, tag: "FilesOpenPath", payload, headers: [] })
    })
  }
  /* oxlint-enable anti-slop-effect/no-manual-tagged-construction */
}

type Done = (error: Error | null, output?: { stdout: string; stderr: string }) => void

type Settled = RpcMessage.ResponseExitEncoded["exit"] | Extract<RpcMessage.FromServerEncoded, { _tag: "Defect" }>

// SAFETY: these are the RPC wire format's plain encoded exits, which the tests expect as is.
/* oxlint-disable anti-slop-effect/no-manual-tagged-construction -- see SAFETY above */
function success<A>(value: A) {
  return { _tag: "Success", value } as const
}

function failed<E>(error: E) {
  return { _tag: "Failure", cause: [{ _tag: "Fail", error }] } as const
}
/* oxlint-enable anti-slop-effect/no-manual-tagged-construction */

function rendererSender(id: number) {
  const events = new EventEmitter()

  // SAFETY: the transport reads only a sender's `id` and `isDestroyed`, and its `destroyed` event.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- see SAFETY above
  return {
    id,
    isDestroyed: () => false,
    once: events.once.bind(events),
    off: events.off.bind(events),
  } as unknown as WebContents
}

function serverPort(port: MessageChannel["port1"]) {
  const listeners = new Map<(event: Electron.MessageEvent) => void, (data: Electron.MessageEvent["data"]) => void>()

  const fake = {
    on(event: string, listener: (event: Electron.MessageEvent) => void) {
      if (event !== "message") {
        port.on(event, listener)

        return
      }

      // SAFETY: the transport reads only the `data` of a message event.
      const wrapped = (data: Electron.MessageEvent["data"]) => listener({ data } as Electron.MessageEvent)
      listeners.set(listener, wrapped)
      port.on("message", wrapped)
    },
    off(event: string, listener: (event: Electron.MessageEvent) => void) {
      if (event !== "message") {
        port.off(event, listener)

        return
      }

      const wrapped = listeners.get(listener)

      if (wrapped) port.off("message", wrapped)
    },
    postMessage: port.postMessage.bind(port),
    start: port.start.bind(port),
    close: port.close.bind(port),
  }

  // SAFETY: the transport uses only these methods of a port.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- see SAFETY above
  return fake as unknown as MessagePortMain
}
