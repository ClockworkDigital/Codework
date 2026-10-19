export * as SessionPower from "./session-power"

import { OpenCode } from "@opencode/client"
import type { PowerSaveBlocker } from "electron"
import { Effect } from "effect"
import { SidecarCredentials } from "./sidecar-credentials"

export const watch = Effect.fn("SessionPower.watch")(function* (
  endpoint: SidecarCredentials.Data,
  blocker: Pick<PowerSaveBlocker, "start" | "stop">,
) {
  const authorization = SidecarCredentials.authorization(endpoint, endpoint.url)

  const client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: authorization ? { authorization } : {},
  })

  const active = new Set<string>()
  let id: number | undefined

  const release = () => {
    if (id === undefined) return
    blocker.stop(id)
    id = undefined
  }

  yield* Effect.addFinalizer(() => Effect.sync(release))
  yield* Effect.tryPromise(async (signal) => {
    for await (const event of client.event.subscribe({ signal })) {
      switch (event.type) {
        case "server.connected": {
          // Subscribe before hydrating so execution boundaries during the snapshot stay queued.
          const snapshot = await client.session.active({ signal })
          signal.throwIfAborted()
          active.clear()
          Object.keys(snapshot).forEach((sessionID) => active.add(sessionID))
          break
        }

        case "session.execution.started":
          active.add(event.data.sessionID)
          break
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted":
        case "session.deleted":
          active.delete(event.data.sessionID)
          break
        default:
          continue
      }

      // Execution spans model calls, tools and retries; only its terminal boundary releases sleep.
      if (active.size && id === undefined) id = blocker.start("prevent-app-suspension")

      if (!active.size) release()
    }
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        active.clear()
        release()
      }),
    ),
    Effect.catch((error) => Effect.logWarning("session power monitor disconnected", { error })),
    Effect.andThen(Effect.sleep("1 second")),
    Effect.forever,
  )
})
