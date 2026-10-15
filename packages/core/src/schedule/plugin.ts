export * as SchedulePlugin from "./plugin.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { CmScheduleRpc } from "@opencode/schema/cm-schedule"
import { ToolFailure } from "@opencode/ai"
import { Effect, Schema } from "effect"
import { Definition } from "./definition.js"
import { ScheduleRuntime } from "./runtime.js"

const Input = Schema.Struct({
  action: Schema.Literals(["list", "create", "update", "pause", "resume", "delete", "acknowledge"]),
  id: Schema.optionalKey(Schema.String),
  definition: Schema.optionalKey(Schema.Unknown),
})

export const Plugin = {
  id: "cookiemonster.schedule",
  effect: Effect.fn(function* (ctx: Context) {
    const runtime = yield* ScheduleRuntime.Service
    yield* runtime.open
    const manage = (value: unknown) =>
      Effect.gen(function* () {
        const input = yield* Schema.decodeUnknownEffect(Input)(value).pipe(Effect.orDie)
        const scheduler = yield* runtime.open
        return yield* Effect.promise(async () => {
          if (input.action === "list") {
            const state = await scheduler.list()
            return { ...state, occurrences: state.occurrences.slice(-100), totalOccurrences: state.occurrences.length }
          }
          if (input.action === "create") return scheduler.put(Definition.parse(input.definition))
          if (!input.id) throw new Error("Schedule id is required")
          if (input.action === "update") return scheduler.put(Definition.parse(input.definition), input.id)
          if (input.action === "delete") {
            await scheduler.remove(input.id)
            return { deleted: input.id }
          }
          if (input.action === "acknowledge") return scheduler.acknowledge(input.id)
          return scheduler.pause(input.id, input.action === "resume")
        })
      })
    const rpc = yield* ctx.rpc
      .register(CmScheduleRpc, {
        list: () => manage({ action: "list" }),
        manage,
      })
      .pipe(Effect.orDie)
    const run = Effect.runPromiseWith(yield* Effect.context())
    const stop = runtime.subscribe((item) =>
      run(
        rpc.events.emit("updated", {
          id: item.id,
          name: item.definition.name,
          state: item.state,
          ...(item.detail ? { detail: item.detail } : {}),
        }),
      ),
    )
    yield* Effect.addFinalizer(() => Effect.sync(stop))
    yield* ctx.tool.transform((editor) =>
      editor.add({
        name: "schedule",
        description:
          "Manage durable scheduled tasks while CookieMonster is running. List tasks and run history, create, update, pause, resume, delete, or acknowledge a run. Obtain the user's scheduling instructions before creating or changing tasks.",
        input: Input,
        options: { codemode: false },
        execute: (input, context) =>
          Effect.gen(function* () {
            yield* ctx.permission
              .assert({
                sessionID: context.sessionID,
                action: "schedule",
                resources: [input.action],
                save: [],
                metadata: {},
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              .pipe(Effect.mapError((error) => new ToolFailure({ message: "Schedule permission denied", error })))
            const result = yield* manage(input)
            return { content: JSON.stringify(result), metadata: { title: `Schedule ${input.action}` } }
          }),
      }),
    )
  }),
}
