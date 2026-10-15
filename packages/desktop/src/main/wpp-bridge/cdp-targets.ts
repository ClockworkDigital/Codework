import type { WebContents } from "electron"

export type InstallTarget = (sessionId?: string) => Promise<void>

type TargetHub = {
  dbg: WebContents["debugger"]
  installers: InstallTarget[]
  sessions: Set<string>
  armed: boolean
}

const hubs = new WeakMap<WebContents, TargetHub>()

// Register an installer for this WebContents. Does not enable auto-attach — call armTargetAttach
// after every installer is registered (recorder, controller, network witness) so a paused child
// iframe always receives the full set before Runtime.runIfWaitingForDebugger. Applying a late
// installer to sessions already seen covers the root target and any child that attached early.
export async function installInRootAndChildTargets(contents: WebContents, install: InstallTarget) {
  const hub = ensureHub(contents)
  hub.installers.push(install)

  for (const key of hub.sessions) {
    await install(key === "root" ? undefined : key)
  }
}

// Enable Target.setAutoAttach once, with waitForDebuggerOnStart, so assistant iframes stay paused
// until every registered installer has run. Mirrors packages/desktop/src/main/browser/transfer-permissions.ts.
export async function armTargetAttach(contents: WebContents) {
  const hub = ensureHub(contents)

  if (hub.armed) return
  hub.armed = true

  hub.dbg.on("message", (_event, method, params) => {
    if (method !== "Target.attachedToTarget") return
    const sessionId = (params as { sessionId?: string })?.sessionId

    if (!sessionId || hub.sessions.has(sessionId)) return
    void attachChild(hub, sessionId)
  })

  await hub.dbg.sendCommand("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  })

  await runTargetInstallers(hub.installers, undefined)
  hub.sessions.add("root")
}

// Pure coordinator used by arm/attach and unit tests: run installers in registration order, then
// resume a paused child. Root (no sessionId) is never waiting for debugger.
export async function runTargetInstallers(
  installers: ReadonlyArray<InstallTarget>,
  sessionId: string | undefined,
  resume?: (sessionId: string) => Promise<void>,
) {
  for (const install of installers) await install(sessionId)

  if (sessionId && resume) await resume(sessionId)
}

function ensureHub(contents: WebContents): TargetHub {
  const existing = hubs.get(contents)

  if (existing) return existing

  const dbg = contents.debugger

  if (!dbg.isAttached()) dbg.attach("1.3")

  const hub: TargetHub = {
    dbg,
    installers: [],
    sessions: new Set(),
    armed: false,
  }

  hubs.set(contents, hub)

  return hub
}

async function attachChild(hub: TargetHub, sessionId: string) {
  hub.sessions.add(sessionId)

  try {
    await runTargetInstallers(hub.installers, sessionId, (id) =>
      hub.dbg.sendCommand("Runtime.runIfWaitingForDebugger", {}, id).then(() => undefined),
    )
  } catch {
    hub.sessions.delete(sessionId)
    // Always resume so a failed installer cannot leave the iframe hung forever.
    await hub.dbg.sendCommand("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined)
  }
}
