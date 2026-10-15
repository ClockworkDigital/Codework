export * as CmAePlugin from "./plugin.js"

import path from "node:path"
import { readFile } from "node:fs/promises"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema, Stream } from "effect"
import { z } from "zod"
import { Global } from "@opencode/util/global"
import { Skill } from "../skill.js"
import { SkillFile } from "../config/plugin/skill-file.js"
import { Config } from "../config.js"
import { Session } from "../session.js"
import { SessionEvent } from "../session/event.js"
import { Permission } from "../permission.js"
import { Bus } from "../bus.js"
import { client } from "./client.js"
import { skills } from "./skills.js"

interface LegacyTool {
  description: string
  args: Record<string, z.ZodType>
  execute: (
    input: unknown,
    context: {
      sessionID: string
      messageID: string
      agent: string
      directory: string
      worktree: string
      abort: AbortSignal
      metadata: (value: Record<string, unknown>) => void
      ask: (request: {
        permission: string
        patterns: string[]
        always: string[]
        metadata?: Record<string, unknown>
      }) => Promise<void>
    },
  ) => Promise<
    | string
    | {
        output: string
        title?: string
        metadata?: Record<string, Schema.Json>
        attachments?: { url: string; mime: string; filename?: string }[]
      }
  >
}
interface LegacyPlugin {
  tool: Record<string, LegacyTool>
  config: (config: { permission: Record<string, typeof Permission.Effect.Type> }) => Promise<void>
  event: (input: { event: { type: string; properties: Record<string, unknown> } }) => Promise<void>
  dispose: () => Promise<void>
}
interface Bundle {
  server: (
    input: { directory: string; client: ReturnType<typeof client> },
    options: { releaseMetadata: { cookieMonsterVersion: string } },
  ) => Promise<LegacyPlugin>
}
const Effects = z.record(z.string(), z.enum(["allow", "ask", "deny"]))
const reads = new Set([
  "ae_connections",
  "ae_inspect",
  "ae_render_list",
  "ae_render_status",
  "ae_render_result",
  "ae_diagnostics",
])

export const Plugin = {
  id: "cookiemonster.ae",
  effect: Effect.fn(function* (ctx: Context) {
    const url = process.env.CM_AE_PLUGIN_URL
    if (!url) return
    const sessions = yield* Session.Service
    const global = yield* Global.Service
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const run = Effect.runPromiseWith(yield* Effect.context())
    const nativeRun = <A, E>(work: Effect.Effect<A, E>, signal?: AbortSignal) => run(work, { signal })
    const changed = new Map<string, Skill.Info | undefined>()
    yield* ctx.skill.transform((editor) => {
      for (const [file, skill] of changed) {
        const previous = editor.list().find((item) => item.path === file)
        if (previous) editor.remove(previous.id)
        if (skill) editor.add(skill)
      }
    })
    const techniques = skills({
      directory: ctx.location.directory,
      config: global.config,
      list: () => nativeRun(ctx.skill.list()).then((response) => [...response.data]),
      changed: async (file, deleted) => {
        const parsed = deleted
          ? undefined
          : SkillFile.parse(path.dirname(path.dirname(file)), file, await readFile(file, "utf8"))
        if (!deleted && parsed?._tag !== "Parsed") throw new Error("Saved AE skill could not be loaded by V2")
        changed.set(file, parsed?._tag === "Parsed" ? parsed.skill : undefined)
        await nativeRun(ctx.skill.reload())
      },
    })
    const permissions = Effects.parse(
      JSON.parse(yield* Effect.promise(() => readFile(new URL("./permissions.json", url), "utf8"))),
    )
    const rules = (yield* config.entries()).flatMap((entry) =>
      entry.type === "document" ? (entry.info.permissions ?? []) : [],
    )
    const policy = Object.fromEntries(
      Object.entries(permissions).map(([name, effect]) => [
        name,
        Permission.evaluate(name, "*", [{ action: name, resource: "*", effect }], rules).effect,
      ]),
    )
    // SAFETY: the desktop validates this exact fork-owned bundle before providing its file URL.
    const bundle = (yield* Effect.promise(() => import(url))) as Bundle
    const legacy = yield* Effect.acquireRelease(
      Effect.promise(() =>
        bundle.server(
          { directory: ctx.location.directory, client: client({ ctx, sessions, techniques, run: nativeRun }) },
          { releaseMetadata: { cookieMonsterVersion: process.env.CM_AE_VERSION ?? ctx.app.version } },
        ),
      ),
      (instance) => Effect.promise(() => instance.dispose()),
    )
    yield* Effect.promise(() => legacy.config({ permission: policy }))
    yield* ctx.agent.transform((editor) => {
      for (const agent of editor.list())
        agent.permissions.unshift(
          ...Object.entries(permissions).map(([action, effect]) => ({ action, resource: "*", effect })),
        )
    })
    // Privileged AE operations retain explicit review even if an agent has a broad allow rule.
    yield* ctx.permission.hook("evaluate", (event) =>
      Effect.sync(() => {
        if (event.action in permissions && !reads.has(event.action) && event.effect === "allow") event.effect = "ask"
      }),
    )
    yield* ctx.tool.transform((editor) => {
      for (const [name, tool] of Object.entries(legacy.tool))
        editor.add({
          name,
          description: tool.description,
          input: z.object(tool.args),
          options: { codemode: false },
          execute: (args, context) =>
            Effect.promise(async (signal) => {
              if (reads.has(name) || name === "ae_pair")
                await nativeRun(
                  ctx.permission.assert({
                    sessionID: context.sessionID,
                    action: name,
                    resources: ["*"],
                    save: [],
                    metadata: {},
                    source: { type: "tool", messageID: context.messageID, id: context.id },
                  }),
                  signal,
                )
              const result = await tool.execute(args, {
                sessionID: context.sessionID,
                messageID: context.messageID,
                agent: context.agent,
                directory: ctx.location.directory,
                worktree: ctx.location.directory,
                abort: signal,
                metadata: (value) => void nativeRun(context.progress(value)),
                ask: (request) =>
                  nativeRun(
                    ctx.permission.assert({
                      sessionID: context.sessionID,
                      action: request.permission,
                      resources: request.patterns,
                      save: request.always,
                      metadata: request.metadata,
                      source: { type: "tool", messageID: context.messageID, id: context.id },
                    }),
                    signal,
                  ),
              })
              if (typeof result === "string") return { content: result }
              return {
                content: [
                  { type: "text" as const, text: result.output },
                  ...(result.attachments ?? []).map((file) => ({
                    type: "file" as const,
                    uri: file.url,
                    mime: file.mime,
                    name: file.filename,
                  })),
                ],
                metadata: { ...result.metadata, ...(result.title === undefined ? {} : { title: result.title }) },
              }
            }),
        })
    })
    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        const history = yield* sessions.messages({ sessionID: event.sessionID, order: "desc" }).pipe(Effect.orDie)
        const prompt = history.find((message) => message.type === "user")
        const system = Schema.decodeUnknownOption(Schema.String)(prompt?.metadata?.cmAeSystem)
        if (system._tag === "Some") {
          event.system.push({ type: "text", text: system.value })
          delete event.tools.question
        }
      }),
    )
    yield* bus
      .subscribe([
        SessionEvent.Deleted,
        Permission.Event.Asked,
        Permission.Event.Replied,
        SessionEvent.Execution.Failed,
      ])
      .pipe(
        Stream.runForEach((event) =>
          Effect.promise(() => {
            if (event.type === "session.deleted")
              return legacy.event({ event: { type: event.type, properties: { info: { id: event.data.sessionID } } } })
            if (event.type === "session.execution.failed")
              return legacy.event({
                event: {
                  type: "session.error",
                  properties: { sessionID: event.data.sessionID, error: event.data.error },
                },
              })
            if (event.type === "permission.asked")
              return legacy.event({
                event: {
                  type: event.type,
                  properties: { ...event.data, permission: event.data.action, patterns: event.data.resources },
                },
              })
            return legacy.event({ event: { type: event.type, properties: event.data } })
          }),
        ),
        Effect.forkScoped,
      )
  }),
}
