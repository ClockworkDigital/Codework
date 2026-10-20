import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Config } from "@opencode/schema/config"
import { Effect, Schedule, Schema } from "effect"
import { Skill } from "@opencode/schema/skill"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"
import { AbsolutePath } from "@opencode/schema/schema"

it.live("returns ordered config entries for the requested directory", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-endpoint-")))
    const global = path.join(tmp.path, "global")
    const project = path.join(tmp.path, "project")
    const config = path.join(project, "opencode.json")
    yield* Effect.promise(() =>
      Promise.all([fs.mkdir(global, { recursive: true }), fs.mkdir(project, { recursive: true })]),
    )
    yield* Effect.promise(() =>
      fs.writeFile(
        config,
        JSON.stringify({
          permissions: [
            { action: "shell", resource: "*", effect: "ask" },
            { action: "shell", resource: "git status", effect: "allow" },
          ],
          mcp: { servers: { docs: { type: "remote", url: "https://example.com/mcp" } } },
        }),
      ),
    )
    const server = yield* startServer(global)
    const url = new URL("/api/config", server.base)
    url.searchParams.set("location[directory]", project)
    const response = yield* Effect.promise(() => fetch(url, { headers: server.headers }))
    const body: unknown = yield* Effect.promise(() => response.json())
    const entries = Schema.decodeUnknownSync(Schema.Array(Config.Entry))(body)

    expect(response.status).toBe(200)
    expect(Array.isArray(entries)).toBe(true)
    const document = entries.find(
      (entry): entry is Config.Document => entry.type === "document" && entry.path === config,
    )
    expect(document?.info.permissions).toEqual([
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "git status", effect: "allow" },
    ])
    expect(document?.path).toBe(AbsolutePath.make(config))
    if (!Array.isArray(body)) throw new Error("Expected a config entry array")
    const raw = body.find((entry) => isRecord(entry) && entry["type"] === "document" && entry["path"] === config)
    if (!isRecord(raw) || !isRecord(raw["info"])) throw new Error("Expected a config document")
    expect(raw["info"]).not.toHaveProperty("default_agent")
    expect(raw["info"]).not.toHaveProperty("model")
    const mcp = raw["info"]["mcp"]
    if (!isRecord(mcp) || !isRecord(mcp["servers"]) || !isRecord(mcp["servers"]["docs"]))
      throw new Error("Expected an MCP server config")
    expect(mcp["servers"]["docs"]).not.toHaveProperty("headers")
    expect(mcp["servers"]["docs"]).not.toHaveProperty("oauth")
  }),
)

it.live("updates the global shell without replacing unrelated JSONC", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-shells-")))
    const global = path.join(tmp.path, "global")
    const config = path.join(global, "opencode.jsonc")
    yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
    yield* Effect.promise(() =>
      fs.writeFile(
        config,
        `{
  // keep this comment
  "model": "provider/model",
  "shell": "bash"
}
`,
      ),
    )
    const server = yield* startServer(global)
    const response = yield* Effect.promise(() =>
      fetch(new URL("/api/experimental/config", server.base), {
        method: "PATCH",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({ shell: "/bin/zsh" }),
      }),
    )

    expect(response.status).toBe(204)
    const text = yield* Effect.promise(() => fs.readFile(config, "utf8"))
    expect(text).toContain("// keep this comment")
    expect(text).toContain('"model": "provider/model"')
    expect(text).toContain('"shell": "/bin/zsh"')

    const shells = yield* Effect.promise(() =>
      fetch(new URL("/api/config/shell", server.base), { headers: server.headers }),
    )
    expect(shells.status).toBe(200)
    expect(Array.isArray(yield* Effect.promise(() => shells.json()))).toBe(true)
  }),
)

it.live("persists a skill toggle across locations and preserves other configuration", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-skill-")))
    const global = path.join(tmp.path, "global")
    const config = path.join(global, "opencode.jsonc")
    yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
    yield* Effect.promise(() =>
      fs.writeFile(
        config,
        `{
  // keep this comment
  "shell": "bash",
  "policies": [{ "action": "tool.use", "resource": "shell:dangerous", "effect": "deny" }]
}\n`,
      ),
    )
    const server = yield* startServer(global, true)
    const skills = (directory: string) =>
      Effect.promise(async () => {
        const url = new URL("/api/skill", server.base)
        url.searchParams.set("location[directory]", directory)
        const models = new URL(url)
        models.pathname = "/api/model"
        expect((await fetch(models, { headers: server.headers })).status).toBe(200)
        const response = await fetch(url, { headers: server.headers })
        expect(response.status).toBe(200)
        const body: unknown = await response.json()
        return Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(Skill.Info) }))(body).data.map(
          (skill) => skill.id,
        )
      })
    const project = path.join(tmp.path, "project")
    yield* Effect.promise(() => fs.mkdir(project, { recursive: true }))
    // A project cannot silently re-enable guidance the user disabled globally.
    yield* Effect.promise(() =>
      fs.writeFile(
        path.join(project, "opencode.json"),
        JSON.stringify({
          policies: [{ action: "integration.use", resource: "skill:report", effect: "allow" }],
        }),
      ),
    )
    expect(yield* skills(project)).toEqual(expect.arrayContaining(["report", "opencode"]))

    for (const enabled of [false, true]) {
      const response = yield* Effect.promise(() =>
        fetch(new URL("/api/experimental/config", server.base), {
          method: "PATCH",
          headers: { ...server.headers, "content-type": "application/json" },
          body: JSON.stringify({ skill: { id: "report", enabled } }),
        }),
      )
      expect(response.status).toBe(204)
      const current = yield* skills(project).pipe(
        Effect.repeat({
          until: (ids) => ids.includes(Skill.ID.make("report")) === enabled,
          schedule: Schedule.spaced("25 millis"),
        }),
        Effect.timeout("5 seconds"),
      )
      expect(current).toContain(Skill.ID.make("opencode"))
      const another = path.join(tmp.path, `another-${enabled}`)
      yield* Effect.promise(() => fs.mkdir(another, { recursive: true }))
      expect((yield* skills(another)).includes(Skill.ID.make("report"))).toBe(enabled)
      const text = yield* Effect.promise(() => fs.readFile(config, "utf8"))
      expect(text).toContain("// keep this comment")
      const entries = yield* Effect.promise(async () => {
        const response = await fetch(new URL("/api/config", server.base), { headers: server.headers })
        const body: unknown = await response.json()
        return Schema.decodeUnknownSync(Schema.Array(Config.Entry))(body)
      })
      const info = entries.find((entry) => entry.type === "document" && entry.path === config)
      expect(info?.type === "document" && info.info).toMatchObject({
        shell: "bash",
        policies: [
          { action: "tool.use", resource: "shell:dangerous", effect: "deny" },
          { action: "integration.use", resource: "skill:report", effect: enabled ? "allow" : "deny" },
        ],
      })
    }
  }),
  // Allow watched-server lifecycle overhead outside the per-update five-second polls.
  15_000,
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
