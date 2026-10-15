export * as ScheduleRuntime from "./runtime.js"

import path from "node:path"
import { stat } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Context, Effect, Layer, Scope, Schema } from "effect"
import { makeGlobalNode, Node } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { AbsolutePath } from "@opencode/schema/schema"
import { SessionMessage } from "@opencode/schema/session-message"
import { Agent } from "../agent.js"
import { Model } from "../model.js"
import { Session } from "../session.js"
import { SessionExecution } from "../session/execution.js"
import { Location } from "../location.js"
import { LocationServiceMap } from "../location-service-map.js"
import { Definition } from "./definition.js"
import { Busy, Scheduler, type Occurrence } from "./engine.js"
import { prepareWorktree } from "./worktree.js"

export interface Interface {
  readonly open: Effect.Effect<Scheduler>
  readonly subscribe: (listener: (item: Occurrence) => Promise<void>) => () => void
}
export class Service extends Context.Service<Service, Interface>()("cookiemonster/Scheduler") {}

const git = promisify(execFile)
const bridge = () =>
  `http://${process.env.O1_CODE_PROXY_HOST ?? "127.0.0.1"}:${process.env.O1_CODE_PROXY_PORT ?? "8787"}`

export const layer: Layer.Layer<
  Service,
  never,
  Global.Service | Session.Service | SessionExecution.Service | LocationServiceMap.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const listeners = new Set<(item: Occurrence) => Promise<void>>()
    const scope = yield* Scope.Scope
    const global = yield* Global.Service
    const sessions = yield* Session.Service
    const execution = yield* SessionExecution.Service
    const locations = yield* LocationServiceMap.Service
    const run = Effect.runPromiseWith(yield* Effect.context())
    const inDirectory = <A, E>(directory: string, work: Effect.Effect<A, E, Agent.Service | Model.Service>) =>
      work.pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))))
    const find = (id: string) =>
      run(
        sessions
          .get(Session.ID.make(id))
          .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined))),
      )
    const messages = (id: string) => run(sessions.messages({ sessionID: Session.ID.make(id), order: "asc" }))
    const reconcile = async (item: Occurrence) => {
      const session = await find(item.sessionID)
      if (!session) return "absent" as const
      const history = await messages(item.sessionID)
      const prompt = history.findIndex((message) => message.id === item.promptID)
      if (prompt < 0)
        return (await run(sessions.inbox(Session.ID.make(item.sessionID)))).some((input) => input.id === item.promptID)
          ? ("admitted" as const)
          : ("absent" as const)
      const following = history.slice(prompt + 1)
      if (following.some((message) => message.type === "user")) return "uncertain" as const
      const assistant = following.findLast((message) => message.type === "assistant")
      return session.outcome === "succeeded" &&
        assistant?.type === "assistant" &&
        assistant.finish === "stop" &&
        !assistant.error &&
        assistant.time.completed &&
        !assistant.content.some((part) => part.type === "tool" && part.state.status !== "completed")
        ? ("completed" as const)
        : ("uncertain" as const)
    }
    const scheduler = new Scheduler(path.join(global.data, "scheduling", "schedules.json"), {
      async normalize(definition) {
        if (definition.target.type === "existing_session") {
          const session = await find(definition.target.sessionID)
          if (!session) throw new Error("Target session does not exist on this local server")
          return { definition, directory: session.location.directory }
        }
        const target = definition.target
        if (!(await stat(target.directory)).isDirectory()) throw new Error("Target is not a directory")
        if (target.workspace.type === "worktree")
          await git("git", [
            "-C",
            target.directory,
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${target.workspace.baseRef}^{commit}`,
          ])
        const resolved = await run(
          inDirectory(
            target.directory,
            Effect.gen(function* () {
              const agents = yield* Agent.Service
              const models = yield* Model.Service
              const agent = target.agent ?? (yield* agents.select()).id
              if (!(yield* agents.get(Agent.ID.make(agent)))) throw new Error("Scheduled agent does not exist")
              const selected = target.model ?? (yield* models.default())
              if (!selected) throw new Error("Scheduled model does not exist")
              const available = (yield* models.available()).find(
                (model) => model.providerID === selected.providerID && model.id === selected.id,
              )
              if (
                !available ||
                ("variant" in selected &&
                  selected.variant &&
                  !available.variants.some((variant) => variant.id === selected.variant))
              )
                throw new Error("Scheduled model variant does not exist")
              return {
                ...definition,
                target: {
                  ...target,
                  agent,
                  model: {
                    providerID: selected.providerID,
                    id: selected.id,
                    ...("variant" in selected ? { variant: selected.variant } : {}),
                  },
                },
              }
            }),
          ),
        )
        return { definition: Definition.parse(resolved), directory: target.directory }
      },
      async authenticate(item) {
        const session = item.definition.target.type === "existing_session" ? await find(item.sessionID) : undefined
        const provider =
          item.definition.target.type === "new_session"
            ? item.definition.target.model?.providerID
            : session?.model?.providerID
        if (provider !== "cookiemonster") return true
        const response = await fetch(`${bridge()}/bridge/auth`, { signal: AbortSignal.timeout(15_000) }).catch(
          () => undefined,
        )
        if (!response?.ok) return false
        const state: unknown = await response.json().catch(() => undefined)
        return !!state && typeof state === "object" && "status" in state && state.status === "signed-in"
      },
      async requestLogin() {
        const response = await fetch(`${bridge()}/bridge/login`, {
          method: "POST",
          signal: AbortSignal.timeout(15_000),
        })
        if (!response.ok) throw new Error("Could not open WPP sign-in")
      },
      reconcile,
      async execute(item, authorize, persist) {
        const target = item.definition.target
        const sessionID = Session.ID.make(item.sessionID)
        if (await run(execution.isActive(sessionID))) throw new Busy("Waiting for the target session to become idle")
        if (target.type === "new_session" && target.workspace.type === "worktree")
          await prepareWorktree(
            item,
            path.join(global.data, "scheduled-worktrees"),
            (await scheduler.list()).occurrences.filter((value) => value.worktree).length,
            persist,
          )
        const existing = await find(item.sessionID)
        if (target.type === "new_session" && existing && existing.metadata?.scheduleOccurrence !== item.id)
          throw new Error("Session ownership does not match this occurrence")
        if (target.type === "new_session" && !existing)
          await run(
            sessions.create({
              id: sessionID,
              title: item.definition.name,
              agent: target.agent ? Agent.ID.make(target.agent) : undefined,
              model: target.model ? Schema.decodeUnknownSync(Model.Ref)(target.model) : undefined,
              location: Location.Ref.make({ directory: AbsolutePath.make(item.directory!) }),
              metadata: { scheduleOccurrence: item.id, scheduleID: item.scheduleID },
            }),
          )
        // A user can start work after the idle check; queue delivery preserves their active execution.
        if (
          !(await authorize(() =>
            run(
              sessions.prompt({
                sessionID,
                id: SessionMessage.ID.make(item.promptID),
                text: `Scheduled task ${item.scheduleID} (occurrence ${item.id}).\n${item.definition.prompt}`,
                delivery: "queue",
                resume: false,
              }),
            ).then(() => undefined),
          ))
        )
          return { state: "cancelled" }
        await run(execution.wake(sessionID))
        await run(sessions.wait(sessionID))
        const completed = (await reconcile(item)) === "completed"
        const assistant = (await messages(item.sessionID)).findLast((message) => message.type === "assistant")
        return {
          state: completed ? "completed" : "attention",
          assistantID: assistant?.id,
          detail: completed ? undefined : "Execution stopped, failed, or was steered by new input; review the session",
        }
      },
      async notify(item) {
        if (item.state === "completed") return
        await Promise.allSettled([...listeners].map((listener) => listener(item)))
      },
    })
    const open = yield* Effect.cached(
      Effect.acquireRelease(
        Effect.promise(() => scheduler.open()),
        () => Effect.promise(() => scheduler.close()),
      ).pipe(
        Effect.tap(() => Effect.sync(() => scheduler.start())),
        Scope.provide(scope),
      ),
    )
    return Service.of({
      open,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    })
  }),
)

export const node: LayerNode.Provider<Service, never, typeof Node.tags.values.global> = makeGlobalNode({
  service: Service,
  layer,
  deps: [Global.node, Session.node, SessionExecution.node, LocationServiceMap.node],
})
