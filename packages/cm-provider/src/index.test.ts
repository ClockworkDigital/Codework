import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenCode } from "@opencode/sdk"
import figma from "@opencode/plugin-figma"
import cookiemonster from "./index"
import { COOKIE_MONSTER_PROVIDER } from "../../desktop/src/main/wpp-bridge/proxy/providerConfig.mjs"
import { MODEL_IDS } from "./modelProfiles.mjs"

test("V2 registers the CookieMonster roster and official Figma tools and skills", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cm-v2-plugins-"))
  try {
    await using host = await OpenCode.create({
      config: { directory, project: false, content: "{}" },
      models: { fetch: false },
      fs: { filewatcher: false },
      plugins: [cookiemonster, figma],
    })
    const models = (await host.model.list()).data
    expect(
      models
        .filter((model) => model.providerID === "cookiemonster")
        .map((model) => model.id)
        .sort(),
    ).toEqual([...MODEL_IDS].sort())
    expect(models.find((model) => model.providerID === "cookiemonster")).toMatchObject({
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      limit: { context: 250_000, output: 128_000 },
    })
    expect((await host.mcp.list()).data).toEqual(expect.arrayContaining([expect.objectContaining({ name: "figma" })]))
    expect((await host.skill.list()).data.map((skill) => skill.id)).toContain("figma-design-to-code")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test.each(["native", "legacy"] as const)(
  "V2 reaches WPP with stable runtime identity through %s provider config",
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "cm-v2-request-"))
    const headers: Headers[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        expect(new URL(request.url).pathname).toBe("/v1/chat/completions")
        const body: unknown = await request.json()
        expect(body).toMatchObject({ model: "CM_GPT6_Sol_High", stream: true })
        headers.push(request.headers)
        return new Response(
          [
            { choices: [{ index: 0, delta: { role: "assistant", content: "ready" }, finish_reason: null }] },
            {
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 10, completion_tokens: 2 },
            },
          ]
            .map(
              (chunk) =>
                `data: ${JSON.stringify({ id: "cm-test", object: "chat.completion.chunk", created: 0, ...chunk })}\n\n`,
            )
            .join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    try {
      await using host = await OpenCode.create({
        config: {
          directory,
          project: false,
          content: JSON.stringify({
            model: "cookiemonster/CM_GPT6_Sol_High",
            ...(kind === "legacy"
              ? {
                  provider: {
                    cookiemonster: {
                      ...COOKIE_MONSTER_PROVIDER,
                      options: { ...COOKIE_MONSTER_PROVIDER.options, baseURL: `${server.url}v1` },
                    },
                  },
                }
              : {
                  providers: {
                    cookiemonster: {
                      package: "@opencode/ai/providers/openai-compatible",
                      settings: { baseURL: `${server.url}v1`, apiKey: "local" },
                      models: { CM_GPT6_Sol_High: {} },
                    },
                  },
                }),
          }),
        },
        models: { fetch: false },
        fs: { filewatcher: false },
        plugins: [cookiemonster],
      })
      const session = await host.sessions.create({ title: "WPP transport", location: { directory } })
      for (const text of ["Say ready", "Say ready again"]) {
        await host.sessions.prompt({ sessionID: session.id, text })
        await host.sessions.wait({ sessionID: session.id })
        expect((await host.sessions.get({ sessionID: session.id })).outcome).toBe("succeeded")
        expect(
          (await host.message.list({ sessionID: session.id })).data.some(
            (message) =>
              message.type === "assistant" &&
              message.content.some((part) => part.type === "text" && part.text === "ready"),
          ),
        ).toBe(true)
      }
      expect(headers).toHaveLength(2)
      expect(headers[0].get("x-opencode-runtime-id")).toMatch(/^[a-f\d-]{36}$/)
      expect(headers[1].get("x-opencode-runtime-id")).toBe(headers[0].get("x-opencode-runtime-id"))
      expect(headers[0].get("x-opencode-client")).toBeTruthy()
    } finally {
      server.stop(true)
      await rm(directory, { recursive: true, force: true })
    }
  },
)

test("packaged CM plugins activate with the complete official Figma skill bundle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cm-v2-packaged-"))
  const resources = new URL("../../desktop/resources/cm-plugins/", import.meta.url)
  const source = await Bun.file(new URL("figma/skills-source.json", resources)).json()
  try {
    await using host = await OpenCode.create({
      config: {
        directory,
        project: false,
        content: JSON.stringify({
          plugins: ["provider", "figma", "browser"].map((name) => new URL(`${name}/`, resources).pathname),
        }),
      },
      models: { fetch: false },
      fs: { filewatcher: false },
    })
    expect(
      (await host.model.list({ location: { directory } })).data.some((model) => model.providerID === "cookiemonster"),
    ).toBe(true)
    expect((await host.mcp.list({ location: { directory } })).data).toContainEqual(
      expect.objectContaining({ name: "figma" }),
    )
    const skills = (await host.skill.list({ location: { directory } })).data
    expect(
      skills
        .filter((skill) => source.skills.includes(skill.id))
        .map((skill) => skill.id)
        .sort(),
    ).toEqual(source.skills.toSorted())
    expect(
      (await host.plugin.list({ location: { directory } })).data
        .filter((plugin) => ["cookiemonster.provider", "cookiemonster.browser", "opencode.figma"].includes(plugin.id))
        .map((plugin) => plugin.state.status),
    ).toEqual(["active", "active", "active"])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
