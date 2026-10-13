import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionOwnership } from "@opencode-ai/core/session/ownership"
import { Flock } from "@opencode-ai/core/util/flock"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Global } from "@opencode-ai/core/global"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { MessageID } from "@/session/schema"
import { Busy, Scheduler, type Adapter } from "../../src/schedule/engine"
import { expect, spyOn } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Option } from "effect"
import { mkdtemp } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { reserve } from "../fixture/scheduled-preparation"

const database = Layer.unwrap(
  Effect.gen(function* () {
    // The package preload owns this isolated data directory and retries Windows
    // SQLite cleanup after all test runtimes have closed their handles.
    const directory = yield* Effect.promise(() => mkdtemp(path.join(Global.Path.data, "session-admission-")))
    return Database.layerFromPath(path.join(directory, "sessions.db"))
  }),
)

const it = testEffect(
  Layer.mergeAll(
    TestLLMServer.layer,
    LayerNode.compile(
      LayerNode.group([
        SessionPrompt.node,
        Session.node,
        SessionProjector.node,
        SessionStatus.node,
        Database.node,
        Project.node,
      ]),
      [
        [Database.node, database],
        [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
      ],
    ),
  ),
)

for (const boundary of ["ownership", "preparation"] as const) {
  for (const action of ["pause", "delete"] as const) {
    it.instance(
      `${action} during ${boundary} prevents durable scheduled admission`,
      () =>
        Effect.gen(function* () {
          const instance = yield* TestInstance
          const database = yield* Database.Service
          const sessions = yield* Session.Service
          const prompts = yield* SessionPrompt.Service
          const status = yield* SessionStatus.Service
          const projects = yield* Project.Service
          yield* projects.fromDirectory(instance.directory)
          const llm = yield* TestLLMServer
          const context = yield* Effect.context()
          yield* Effect.promise(() =>
            Bun.write(
              path.join(instance.directory, "opencode.json"),
              JSON.stringify({
                model: "test/test-model",
                plugin: [pathToFileURL(path.join(import.meta.dir, "../fixture/scheduled-preparation.ts")).href],
                provider: {
                  test: {
                    npm: "@ai-sdk/openai-compatible",
                    models: { "test-model": { name: "Test", limit: { context: 100000, output: 1000 } } },
                    options: { apiKey: "test-key", baseURL: llm.url },
                  },
                },
              }),
            ),
          )
          yield* llm.text("This must not execute")
          const chat = yield* sessions.create({
            title: "Scheduled ownership race",
            agent: "build",
            model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") },
          })
          const preparation = boundary === "preparation" ? reserve(chat.id) : undefined
          yield* Effect.addFinalizer(() => Effect.sync(() => preparation?.release()))
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const control = { now: Date.parse("2026-10-08T08:00:00Z"), writes: 0 }
          const adapter: Adapter = {
            normalize: async (definition) => ({ definition, directory: instance.directory }),
            authenticate: async () => true,
            requestLogin: async () => {},
            reconcile: async () => "absent",
            notify: async () => {},
            execute: async (item, authorize) => {
              const result = await Effect.runPromiseWith(context)(
                prompts
                  .scheduled(
                    {
                      sessionID: chat.id,
                      messageID: MessageID.make(item.promptID),
                      parts: [{ type: "text", text: item.definition.prompt }],
                    },
                    async (persist) =>
                      authorize(async () => {
                        await persist()
                        control.writes++
                      }),
                  )
                  .pipe(Effect.catchTag("ScheduledAdmissionDenied", () => Effect.succeed("cancelled" as const))),
              )
              if (result === "cancelled") return { state: "cancelled" }
              if (Option.isNone(result)) throw new Busy("Admission was not available")
              return { state: "completed" }
            },
          }
          const engine = yield* Effect.acquireRelease(
            Effect.promise(() =>
              new Scheduler(path.join(instance.directory, "schedules.json"), adapter, () => control.now).open(),
            ),
            (engine) => Effect.promise(() => engine.close()),
          )
          const saved = yield* Effect.promise(() =>
            engine.put({
              schemaVersion: 1,
              name: "Ownership wait",
              prompt: "This prompt must not be admitted",
              target: { type: "existing_session", sessionID: chat.id },
              schedule: { type: "once", at: "2026-10-08T08:01:00Z" },
            }),
          )
          const owner =
            boundary === "ownership"
              ? yield* SessionOwnership.withLock(
                  Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
                  chat.id,
                  database.filename,
                ).pipe(Effect.forkChild)
              : undefined
          if (owner) yield* awaitWithTimeout(Deferred.await(entered), "session ownership was not acquired")
          const waiting = Promise.withResolvers<void>()
          if (owner) {
            // Observe the real lock's retry callback, rather than guessing from runner status.
            const acquire = Flock.acquire
            const probe = spyOn(Flock, "acquire").mockImplementation((key, options) =>
              acquire(key, {
                ...options,
                onWait: async (event) => {
                  await options?.onWait?.(event)
                  waiting.resolve()
                },
              }),
            )
            yield* Effect.addFinalizer(() => Effect.sync(() => probe.mockRestore()))
          }
          control.now += 60000
          const tick = engine.tick()
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(release, undefined).pipe(
              Effect.andThen(Effect.sync(() => preparation?.release())),
              Effect.andThen(Effect.promise(() => tick)),
            ),
          )
          if (preparation)
            yield* awaitWithTimeout(
              Effect.promise(() => preparation.ready),
              "prompt preparation was not reached",
              "45 seconds",
            )
          if (owner)
            yield* awaitWithTimeout(
              Effect.promise(() => waiting.promise),
              "scheduled runner never waited for session ownership",
            )
          expect(yield* status.get(chat.id)).toEqual({ type: "busy" })
          if (action === "pause") yield* Effect.promise(() => engine.pause(saved.id))
          if (action === "delete") yield* Effect.promise(() => engine.remove(saved.id))
          expect(yield* sessions.messages({ sessionID: chat.id })).toHaveLength(0)
          yield* Deferred.succeed(release, undefined)
          preparation?.release()
          if (owner) yield* Fiber.join(owner)
          yield* awaitWithTimeout(
            Effect.promise(() => tick),
            "scheduled dispatch did not settle",
            "45 seconds",
          )
          expect(yield* sessions.messages({ sessionID: chat.id })).toHaveLength(0)
          expect(control.writes).toBe(0)
          expect(yield* llm.hits).toHaveLength(0)
          const state = yield* Effect.promise(() => engine.list())
          expect(state.schedules[0].runs).toBe(0)
          expect(state.occurrences[0].admitted).toBe(false)
          expect(state.occurrences[0].state).toBe(action === "pause" ? "pending" : "skipped")
        }),
      60000,
    )
  }
}
