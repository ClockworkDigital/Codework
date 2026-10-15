import { DateTime, Effect, Schema } from "effect"
import { z } from "zod"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Session } from "../session.js"
import { SessionMessage } from "../session/message.js"
import { Skill } from "../skill.js"
import { Model } from "../model.js"
import { Permission } from "../permission.js"
import { skills } from "./skills.js"

const Options = z.object({
  path: z
    .object({
      id: z.string(),
      messageID: z.string().optional(),
      permissionID: z.string().optional(),
      sessionID: z.string().optional(),
    })
    .optional(),
  query: z
    .object({
      directory: z.string(),
      before: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .optional(),
  body: z.unknown().optional(),
  signal: z.instanceof(AbortSignal).optional(),
  url: z.string().optional(),
})
const Prompt = z.object({
  system: z.string(),
  model: z.object({ providerID: z.string(), modelID: z.string() }).optional(),
  variant: z.string().optional(),
  parts: z.array(
    z.union([
      z.object({
        type: z.literal("text"),
        text: z.string(),
        synthetic: z.boolean().optional(),
        metadata: z
          .object({ cmSkill: z.object({ name: z.string(), source: z.string(), revision: z.string() }) })
          .optional(),
      }),
      z.object({ type: z.literal("file"), url: z.string(), mime: z.string(), filename: z.string().optional() }),
    ]),
  ),
})

/** Translate the pinned AE panel's legacy wire shapes at one boundary; execution stays in native V2. */
export function client(input: {
  ctx: Context
  sessions: Session.Interface
  techniques: ReturnType<typeof skills>
  run: <A, E>(work: Effect.Effect<A, E>, signal?: AbortSignal) => Promise<A>
}) {
  const sessions = input.sessions
  const request =
    <A>(execute: (options: z.infer<typeof Options>) => Promise<A>) =>
    async (value: unknown) => {
      const options = Options.parse(value)
      if (options.query?.directory && options.query.directory !== input.ctx.location.directory)
        throw new Error("AE workspace changed")
      try {
        return { data: await execute(options) }
      } catch (error) {
        return {
          error: { message: error instanceof Error ? error.message : String(error) },
          response: new Response(null, {
            status: error instanceof Error && "status" in error && error.status === 404 ? 404 : 500,
          }),
        }
      }
    }
  const id = (options: z.infer<typeof Options>) => {
    if (!options.path?.id) throw new Error("AE session ID is required")
    return Session.ID.make(options.path.id)
  }
  const owned = async (options: z.infer<typeof Options>) => {
    const session = await input.run(
      sessions.get(id(options)).pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined))),
      options.signal,
    )
    if (!session) throw Object.assign(new Error("AE conversation no longer exists"), { status: 404 })
    if (session.location.directory !== input.ctx.location.directory)
      throw new Error("AE session belongs to another workspace")
    return session
  }
  const info = (session: Session.Info) => ({ ...session, directory: session.location.directory })
  const page = request(async (options) => {
    await owned(options)
    const history = await input.run(
      sessions.messages({
        sessionID: id(options),
        order: "desc",
        limit: options.query?.limit ?? 60,
        cursor: options.query?.before
          ? { id: SessionMessage.ID.make(options.query.before), direction: "previous" }
          : undefined,
      }),
      options.signal,
    )
    // The AE panel owns its own display order and applies its bounded text/image budgets.
    return {
      history: history.flatMap((message) => legacyMessage(message, id(options)) ?? []),
      cursor: history.length === (options.query?.limit ?? 60) ? history.at(-1)?.id : undefined,
    }
  })
  const transport = request(async (options) => {
    if (options.url?.startsWith("/skill/")) return input.techniques.request(options.url.slice(7), options.body)
    if (options.url !== "/api/session/{sessionID}/model" || !options.path?.sessionID)
      throw new Error("Unsupported AE backend operation")
    const request = { ...options, path: { ...options.path, id: options.path.sessionID } }
    await owned(request)
    const body = z
      .object({ model: z.object({ providerID: z.string(), id: z.string(), variant: z.string().optional() }) })
      .parse(options.body)
    await input.run(
      sessions.switchModel({
        sessionID: id(request),
        model: Schema.decodeUnknownSync(Model.Ref)({
          ...body.model,
          variant: body.model.variant === "default" ? undefined : body.model.variant,
        }),
      }),
      options.signal,
    )
    return null
  })
  return {
    _client: { get: transport, post: transport },
    session: {
      get: request(async (options) => info(await owned(options))),
      create: request(async (options) => {
        const body = z.object({ title: z.string() }).parse(options.body)
        return info(
          await input.run(
            input.ctx.session.create({
              title: body.title,
              permissions: [{ action: "question", resource: "*", effect: "deny" }],
            }),
            options.signal,
          ),
        )
      }),
      update: request(async (options) => {
        await owned(options)
        await input.run(
          sessions.rename({ sessionID: id(options), title: z.object({ title: z.string() }).parse(options.body).title }),
          options.signal,
        )
        return null
      }),
      status: request(async (options) =>
        Object.fromEntries(
          [...(await input.run(sessions.active, options.signal))].map((sessionID) => [sessionID, { type: "busy" }]),
        ),
      ),
      messages: async (value: unknown) => {
        const result = await page(value)
        if (result.error) return result
        return {
          data: result.data.history,
          response: new Response(null, { headers: result.data.cursor ? { "x-next-cursor": result.data.cursor } : {} }),
        }
      },
      message: request(async (options) => {
        await owned(options)
        if (!options.path?.messageID) throw new Error("AE message ID is required")
        const message = await input.run(
          sessions.message({ sessionID: id(options), messageID: SessionMessage.ID.make(options.path.messageID) }),
          options.signal,
        )
        return message ? legacyMessage(message, id(options)) : undefined
      }),
      abort: request(async (options) => {
        await owned(options)
        await input.run(sessions.interrupt(id(options)), options.signal)
        return null
      }),
      promptAsync: request(async (options) => {
        await owned(options)
        const body = Prompt.parse(options.body)
        if (body.model)
          await input.run(
            sessions.switchModel({
              sessionID: id(options),
              model: Schema.decodeUnknownSync(Model.Ref)({
                providerID: body.model.providerID,
                id: body.model.modelID,
                variant: body.variant === "default" ? undefined : body.variant,
              }),
            }),
            options.signal,
          )
        const selected = body.parts.flatMap((part) =>
          part.type === "text" && part.metadata?.cmSkill ? [part.metadata.cmSkill] : [],
        )
        const techniques = await Promise.all(selected.map((skill) => input.techniques.resolve(skill)))
        await input.run(
          sessions.prompt({
            sessionID: id(options),
            text: body.parts.flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : [])).join("\n"),
            files: body.parts.flatMap((part) => (part.type === "file" ? [{ uri: part.url, name: part.filename }] : [])),
            skills: techniques.map((skill) => ({
              id: Skill.ID.make(skill.id),
            })),
            metadata: { cmAeSystem: body.system },
          }),
          options.signal,
        )
        return null
      }),
    },
    provider: {
      list: request(async (options) => {
        const response = await input.run(input.ctx.model.list(), options.signal)
        const catalog = response.data
        const all = [...new Set(catalog.map((model) => model.providerID))].map((providerID) => ({
          id: providerID,
          name: providerID,
          models: Object.fromEntries(
            catalog
              .filter((model) => model.providerID === providerID)
              .map((model) => [
                model.id,
                {
                  id: model.id,
                  name: model.name,
                  variants: Object.fromEntries(model.variants.map((variant) => [variant.id, {}])),
                },
              ]),
          ),
        }))
        return { all, connected: all.map((provider) => provider.id) }
      }),
    },
    postSessionIdPermissionsPermissionId: request(async (options) => {
      await owned(options)
      if (!options.path?.permissionID) throw new Error("AE permission ID is required")
      const decision = z.object({ response: z.enum(["once", "reject"]) }).parse(options.body).response
      await input.run(
        input.ctx.permission.reply({
          sessionID: id(options),
          requestID: Permission.ID.make(options.path.permissionID),
          decision,
        }),
        options.signal,
      )
      return null
    }),
  }
}

export function legacyMessage(message: SessionMessage.Info, sessionID: string) {
  if (message.type !== "user" && message.type !== "assistant" && message.type !== "skill") return
  const time = {
    created: DateTime.toEpochMillis(message.time.created),
    completed:
      message.type === "assistant" && message.time.completed
        ? DateTime.toEpochMillis(message.time.completed)
        : undefined,
  }
  const info = {
    id: message.id,
    role: message.type === "assistant" ? "assistant" : "user",
    sessionID,
    time,
    error: message.type === "assistant" ? message.error : undefined,
  }
  if (message.type !== "assistant")
    return {
      info,
      parts: [
        { type: "text", text: message.text, synthetic: message.type === "skill" },
        ...(message.type === "user"
          ? (message.files ?? []).map((file) => ({
              type: "file",
              mime: file.mime,
              filename: file.name,
              url: `data:${file.mime};base64,${file.data}`,
            }))
          : []),
      ],
    }
  return {
    info,
    parts: message.content.map((part) => {
      if (part.type !== "tool") return part
      const content = "content" in part.state ? (part.state.content ?? []) : []
      return {
        type: "tool",
        id: part.id,
        tool: part.name,
        state: {
          ...part.state,
          output: content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n"),
          attachments: content.flatMap((item) =>
            item.type === "file" ? [{ url: item.uri, mime: item.mime, filename: item.name }] : [],
          ),
        },
      }
    }),
  }
}
