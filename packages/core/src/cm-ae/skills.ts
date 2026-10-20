import path from "node:path"
import { randomBytes } from "node:crypto"
import { stat } from "node:fs/promises"
import { AbsolutePath } from "@opencode/schema/schema"
import { Glob } from "@opencode/util/glob"
import { Schema } from "effect"
import type { Skill } from "@opencode/schema/skill"
import { ManagedSkill } from "./managed.js"

/** Reviewed AE-panel writes retain the fork's receipts, exclusive creation and byte-for-byte backups. */
export function skills(input: {
  directory: string
  config: string
  list: () => Promise<Skill.Info[]>
  changed: (file: string, deleted?: boolean) => Promise<void>
}) {
  const reviews = new Map<string, { digest: string; expires: number }>()
  const management = new Map<string, { digest: string; expires: number }>()
  const roots = {
    workspace: path.join(input.directory, ".opencode", "skills"),
    global: path.join(input.config, "skills"),
  }
  let chain: Promise<unknown> = Promise.resolve()
  const fresh = async () => {
    const native = await input.list()
    const files = new Set(native.map((skill) => skill.path))
    for (const root of Object.values(roots)) {
      const exists = await stat(root).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (!exists) continue
      for (const file of await Glob.scan("**/SKILL.md", {
        cwd: root,
        absolute: true,
        symlink: true,
      }))
        files.add(AbsolutePath.make(file))
    }
    return (
      await Promise.all(
        [...files].map(async (file) => {
          const info = await ManagedSkill.snapshot(file).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined
            throw error
          })
          if (!info) return
          return { ...info, id: native.find((skill) => skill.path === file)?.id ?? path.basename(path.dirname(file)) }
        }),
      )
    ).filter((skill) => skill !== undefined)
  }
  const resolve = async (selected: ManagedSkill.Selection) => {
    const matches = (await fresh()).filter((skill) => skill.name === selected.name)
    if (matches.length !== 1 || matches[0].source !== selected.source || matches[0].revision !== selected.revision)
      throw new ManagedSkill.Error({
        message: "Skill is missing, changed or has a duplicate name. Refresh and select it again.",
      })
    return matches[0]
  }
  const target = (draft: ManagedSkill.Draft) => {
    ManagedSkill.validate(draft)
    if (draft.scope === "workspace" && process.env.OPENCODE_DISABLE_PROJECT_CONFIG === "1")
      throw new ManagedSkill.Error({ message: "Workspace skill storage is disabled by CM configuration." })
    return {
      directory: input.directory,
      root: roots[draft.scope],
      destination: path.join(roots[draft.scope], draft.name, "SKILL.md"),
    }
  }
  const remember = (store: typeof reviews, digest: string) => {
    for (const [token, value] of store) if (value.expires < Date.now()) store.delete(token)
    if (store.size >= 1000) throw new ManagedSkill.Error({ message: "Too many pending skill reviews." })
    const token = randomBytes(32).toString("hex")
    store.set(token, { digest, expires: Date.now() + 600000 })
    return token
  }
  const consume = (store: typeof reviews, token: string, digest: string) => {
    const review = store.get(token)
    store.delete(token)
    if (!review || review.digest !== digest || review.expires < Date.now())
      throw new ManagedSkill.Error({
        message: "Review expired, was used, or does not match this exact content and workspace. Review again.",
      })
  }
  const unique = async (name: string, source?: string) => {
    if ((await fresh()).some((skill) => skill.source !== source && skill.name.toLowerCase() === name.toLowerCase()))
      throw new ManagedSkill.Error({ message: "Another skill already uses that name. Nothing was overwritten." })
  }
  return {
    resolve,
    async request(action: string, value: unknown) {
      const work = async () => {
        if (action === "catalog")
          return (await fresh()).map(({ name, description, source, revision }) => ({
            name,
            description,
            source,
            revision,
          }))
        if (action === "validate") return resolve(Schema.decodeUnknownSync(ManagedSkill.Selection)(value))
        if (action === "review" || action === "create") {
          const draft = Schema.decodeUnknownSync(ManagedSkill.Draft)(value)
          const destination = target(draft)
          const digest = ManagedSkill.digest([destination, draft])
          if (action === "review") {
            await unique(draft.name)
            return {
              token: remember(reviews, digest),
              digest,
              directory: input.directory,
              destination: destination.destination,
              scope: draft.scope,
            }
          }
          const token = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }))(value).token
          consume(reviews, token, digest)
          await unique(draft.name)
          const info = await ManagedSkill.create(destination.root, draft)
          await input.changed(info.location)
          await resolve(info)
          return {
            name: info.name,
            description: info.description,
            source: info.source,
            revision: info.revision,
            directory: input.directory,
            destination: destination.destination,
            scope: draft.scope,
            digest,
          }
        }
        if (action !== "manage") throw new Error("Unsupported AE skill operation")
        const args = Schema.decodeUnknownSync(ManagedSkill.Manage)(value)
        const info = await resolve(args.selected)
        const parent = path.dirname(path.dirname(info.location))
        const scope =
          parent === roots.workspace
            ? ("workspace" as const)
            : parent === roots.global
              ? ("global" as const)
              : ("external" as const)
        const editable =
          scope !== "external" && !(scope === "workspace" && process.env.OPENCODE_DISABLE_PROJECT_CONFIG === "1")
        const result = {
          name: info.name,
          description: info.description,
          source: info.source,
          revision: info.revision,
          content: info.content,
          document: info.text,
          location: info.location,
          editable,
          scope,
        }
        if (args.action === "read") return result
        if (!editable || !args.operation)
          throw new ManagedSkill.Error({ message: "This skill is read-only. Copy it into a managed skill to edit it." })
        if (args.operation === "edit") {
          if (!args.draft || args.draft.scope !== scope)
            throw new ManagedSkill.Error({ message: "Keep the existing skill scope when editing." })
          ManagedSkill.validate(args.draft)
          await unique(args.draft.name, info.source)
        }
        if (args.operation === "delete" && args.draft)
          throw new ManagedSkill.Error({ message: "Deletion does not accept replacement content." })
        await ManagedSkill.directory(path.dirname(info.location))
        const digest = ManagedSkill.digest([
          input.directory,
          info.location,
          args.selected,
          args.operation,
          args.draft || null,
        ])
        if (args.action === "review") return { ...result, token: remember(management, digest), digest }
        consume(management, args.token ?? "", digest)
        const changed = await ManagedSkill.change(info.location, args.selected, args.draft)
        await input.changed(info.location, changed.deleted)
        return {
          ...result,
          ...(changed.updated
            ? {
                name: changed.updated.name,
                description: changed.updated.description,
                content: changed.updated.content,
                document: changed.updated.text,
                source: changed.updated.source,
                revision: changed.updated.revision,
              }
            : {}),
          backup: changed.backup,
          deleted: changed.deleted,
          digest,
        }
      }
      const result = chain.then(work)
      chain = result.catch(() => undefined)
      return result
    },
  }
}
