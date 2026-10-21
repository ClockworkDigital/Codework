import { expect, mock, spyOn, test } from "bun:test"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import { app, BrowserWindow } from "electron"
import { Effect, Layer, ManagedRuntime } from "effect"

if (process.env.CM_ACTIVATION_TEST_CHILD !== "1") {
  test("activation restores main windows independently of hidden worker windows", () => {
    const result = Bun.spawnSync([process.execPath, "test", "--preload", "./test/preload.ts", import.meta.path], {
      cwd: join(import.meta.dir, "../../.."),
      env: { ...process.env, CM_ACTIVATION_TEST_CHILD: "1" },
      timeout: 15_000,
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode, Buffer.concat([result.stdout, result.stderr]).toString()).toBe(0)
  }, 20_000)
} else {
  test("Dock activation restores a main window with hidden workers and focuses an existing main window", async () => {
    const events = new EventEmitter()
    app.on = (name, listener) => {
      events.on(name, listener)

      return app
    }

    app.off = (name, listener) => {
      events.off(name, listener)

      return app
    }

    const main: BrowserWindow[] = []
    const shown = mock(() => {})
    const focused = mock(() => {})
    const restored = mock(() => {})

    // SAFETY: This owned native stand-in supplies every operation used by the activation focus path.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- native stand-in, see SAFETY above
    const window = {
      isMinimized: () => true,
      restore: restored,
      show: shown,
      focus: focused,
      isFocused: () => false,
    } as unknown as BrowserWindow

    // SAFETY: The baseline only counts these hidden native workers; the main-window fixture excludes them.
    spyOn(BrowserWindow, "getAllWindows").mockReturnValue([{} as BrowserWindow])

    const restore = mock(() => {
      main.push(window)

      return main
    })

    mock.module("../windows", () => ({
      getMainWindows: () => main,
      getLastFocusedWindow: () => main[0] ?? null,
      getWindowByID: () => null,
      makeMainWindows: () => Effect.succeed({ create: () => window, restore }),
      setAppQuitting: () => {},
      setRelaunchHandler: () => () => {},
    }))
    mock.module("../storage", () => ({
      DesktopStorage: { layer: Layer.empty },
    }))
    mock.module("../native/logging", () => ({
      DesktopLogging: { layer: Layer.empty },
      scoped: <A, E, R>(_scope: string, effect: Effect.Effect<A, E, R>) => effect,
    }))
    mock.module("./onboarding", () => ({
      initializeFirstLaunchOnboarding: () => Effect.void,
    }))
    mock.module("../ipc-events", () => ({ emitIpcEvent: () => {} }))
    const login = Promise.withResolvers<string>()

    const requestLogin = mock(async (origin: string) => {
      login.resolve(origin)
    })

    mock.module("#cm-wpp", () => ({ wpp: { requestLogin } }))
    const { ApplicationLifecycle } = await import("./index")
    const runtime = ManagedRuntime.make(ApplicationLifecycle.layer)

    try {
      const lifecycle = await runtime.runPromise(ApplicationLifecycle.Service)
      lifecycle.restoreWindows()
      expect(restore).toHaveBeenCalledTimes(1)
      main.length = 0
      events.emit("activate")
      expect(restore).toHaveBeenCalledTimes(2)
      expect(main).toHaveLength(1)
      events.emit("activate")
      expect(restore).toHaveBeenCalledTimes(2)
      expect(restored).toHaveBeenCalledTimes(1)
      expect(shown).toHaveBeenCalledTimes(1)
      expect(focused).toHaveBeenCalledTimes(1)
      events.emit("second-instance", {}, ["cm", "cookiemonster://wpp/login?origin=http%3A%2F%2F127.0.0.1%3A18787"])
      expect(await login.promise).toBe("http://127.0.0.1:18787")
      expect(requestLogin).toHaveBeenCalledTimes(1)
      expect(lifecycle.consumeInitialDeepLinks()).toEqual([])
      expect(focused).toHaveBeenCalledTimes(1)
    } finally {
      await runtime.dispose()
      mock.restore()
    }
  })
}
