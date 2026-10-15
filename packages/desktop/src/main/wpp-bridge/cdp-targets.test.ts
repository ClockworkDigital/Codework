// SAFETY: This fixture owns its synthetic native objects, runtime probes and malformed inputs; partial shapes deliberately exercise the production guards.
/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion */
import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { WebContents } from "electron"
import { armTargetAttach, installInRootAndChildTargets, runTargetInstallers } from "./cdp-targets"
import { installRecorder } from "./recorder-injection"

test("installs the recorder when initial loading stops after about:blank has already finished", async () => {
  const contents = Object.assign(new EventEmitter(), {
    getURL: () => "",
    isLoadingMainFrame: () => true,
    loadURL: async () => {
      contents.emit("did-finish-load")
    },
    debugger: { isAttached: () => true },
  })
  const installing = installRecorder(contents as unknown as WebContents)
  await Promise.resolve()
  await Promise.resolve()
  expect(contents.listenerCount("did-fail-load")).toBe(1)
  contents.emit("did-stop-loading")
  try {
    expect(await Promise.race([installing.then(() => true), Bun.sleep(50).then(() => false)])).toBe(true)
    expect(contents.listenerCount("did-stop-loading")).toBe(0)
    expect(contents.listenerCount("did-fail-load")).toBe(0)
  } finally {
    contents.emit("did-fail-load")
    await installing
  }
})

describe("runTargetInstallers", () => {
  test("runs installers in registration order before resume", async () => {
    const steps: string[] = []
    await runTargetInstallers(
      [
        async (sessionId) => {
          steps.push(`recorder:${sessionId}`)
        },
        async (sessionId) => {
          steps.push(`controller:${sessionId}`)
        },
        async (sessionId) => {
          steps.push(`network:${sessionId}`)
        },
      ],
      "iframe-1",
      async (sessionId) => {
        steps.push(`resume:${sessionId}`)
      },
    )
    expect(steps).toEqual(["recorder:iframe-1", "controller:iframe-1", "network:iframe-1", "resume:iframe-1"])
  })

  test("does not resume the root target", async () => {
    const steps: string[] = []
    await runTargetInstallers(
      [
        async () => {
          steps.push("install")
        },
      ],
      undefined,
      async () => {
        steps.push("resume")
      },
    )
    expect(steps).toEqual(["install"])
  })

  test("does not resume when a resume callback is omitted", async () => {
    const steps: string[] = []
    await runTargetInstallers(
      [
        async (sessionId) => {
          steps.push(`install:${sessionId}`)
        },
      ],
      "iframe-2",
    )
    expect(steps).toEqual(["install:iframe-2"])
  })
})

describe("armTargetAttach", () => {
  test("pauses child targets until every registered installer has run", async () => {
    const steps: string[] = []
    const listeners: Array<(...args: unknown[]) => void> = []
    const commands: Array<{ method: string; sessionId?: string; params?: unknown }> = []

    const contents = {
      debugger: {
        isAttached: () => true,
        attach: () => undefined,
        on: (_event: string, listener: (...args: unknown[]) => void) => {
          listeners.push(listener)
        },
        sendCommand: async (method: string, params?: unknown, sessionId?: string) => {
          commands.push({ method, params, sessionId })

          return {}
        },
      },
    } as unknown as WebContents

    await installInRootAndChildTargets(contents, async (sessionId) => {
      steps.push(`recorder:${sessionId ?? "root"}`)
    })
    await installInRootAndChildTargets(contents, async (sessionId) => {
      steps.push(`controller:${sessionId ?? "root"}`)
    })
    await installInRootAndChildTargets(contents, async (sessionId) => {
      steps.push(`network:${sessionId ?? "root"}`)
    })

    // Registering alone must not auto-attach — otherwise a child could resume early.
    expect(commands).toEqual([])
    expect(steps).toEqual([])

    await armTargetAttach(contents)

    expect(commands).toContainEqual({
      method: "Target.setAutoAttach",
      params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      sessionId: undefined,
    })
    expect(steps).toEqual(["recorder:root", "controller:root", "network:root"])

    const beforeChild = steps.length
    listeners[0]?.({}, "Target.attachedToTarget", { sessionId: "iframe-session" })

    // installers are async; wait until resume has been issued for the child.
    const started = Date.now()

    while (
      Date.now() - started < 1000 &&
      !commands.some(
        (command) => command.method === "Runtime.runIfWaitingForDebugger" && command.sessionId === "iframe-session",
      )
    ) {
      await Bun.sleep(5)
    }

    expect(steps.slice(beforeChild)).toEqual([
      "recorder:iframe-session",
      "controller:iframe-session",
      "network:iframe-session",
    ])
    expect(
      commands.some(
        (command) => command.method === "Runtime.runIfWaitingForDebugger" && command.sessionId === "iframe-session",
      ),
    ).toBe(true)
  })
})
