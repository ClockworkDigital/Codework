import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenCode } from "@opencode/sdk"
import figma from "@opencode/plugin-figma"
import cookiemonster from "@cookiemonster/wpp/plugin"
import { COOKIE_MONSTER_PROVIDER } from "./legacy-config.mjs"
import { MODEL_IDS } from "@cookiemonster/wpp/proxy/modelProfiles.mjs"

test("V2 registers the CookieMonster roster, optional desktop setup and official Figma tools and skills", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cm-v2-plugins-"))
  try {
    await using host = await OpenCode.create({
      config: {
        directory,
        project: false,
        content: JSON.stringify({
          plugins: [new URL("./node_modules/@cookiemonster/wpp/provider/", import.meta.url).pathname],
        }),
      },
      models: { fetch: false },
      fs: { filewatcher: false },
      plugins: [figma],
    })
    const models = (await host.model.list({ location: { directory } })).data
    expect(
      models
        .filter((model) => model.providerID === "cookiemonster")
        .map((model) => model.id)
        .sort(),
    ).toEqual([...MODEL_IDS].sort())
    expect(models.find((model) => model.providerID === "cookiemonster")).toMatchObject({
      capabilities: { tools: true, input: ["text", "image"], output: ["text", "image"] },
      limit: { context: 250_000, output: 128_000 },
    })
    expect(models.find((model) => model.providerID === "cookiemonster" && model.id === "CM_Gemini4")).toMatchObject({
      settings: { reasoningEffort: "medium" },
      variants: [
        { id: "low", settings: { reasoningEffort: "low" } },
        { id: "medium", settings: { reasoningEffort: "medium" } },
        { id: "high", settings: { reasoningEffort: "high" } },
      ],
    })
    expect((await host.mcp.list({ location: { directory } })).data).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "figma" })]),
    )
    expect((await host.skill.list({ location: { directory } })).data.map((skill) => skill.id)).toContain(
      "figma-design-to-code",
    )
    expect((await host.skill.list({ location: { directory } })).data.map((skill) => skill.id)).toContain(
      "cm-onboarding",
    )
    expect((await host.skill.list({ location: { directory } })).data).toContainEqual(
      expect.objectContaining({
        id: "open-computer-use",
        description: expect.stringContaining("when desktop tools are missing"),
        content: expect.stringContaining("npm install -g open-computer-use"),
      }),
    )
    expect(
      (await host.mcp.list({ location: { directory } })).data.some((server) => server.name === "open-computer-use"),
    ).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("bundled CM provider exposes optional desktop setup without enabling desktop access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cm-computer-use-"))
  try {
    await using host = await OpenCode.create({
      config: {
        directory,
        project: false,
        content: JSON.stringify({ plugins: [new URL("../resources/cm-plugins/provider/", import.meta.url).pathname] }),
      },
      models: { fetch: false },
      fs: { filewatcher: false },
    })
    expect(
      (await host.model.list({ location: { directory } })).data.some((model) => model.providerID === "cookiemonster"),
    ).toBe(true)
    expect((await host.skill.list({ location: { directory } })).data.map((skill) => skill.id)).toContain(
      "cm-onboarding",
    )
    expect((await host.skill.list({ location: { directory } })).data).toContainEqual(
      expect.objectContaining({
        id: "open-computer-use",
        content: expect.stringContaining("npm install -g open-computer-use"),
      }),
    )
    expect(
      (await host.mcp.list({ location: { directory } })).data.some((server) => server.name === "open-computer-use"),
    ).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test.each(["native", "legacy"] as const)(
  "V2 persists WPP images with stable runtime identity through %s provider config",
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "cm-v2-request-"))
    const headers: Headers[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        expect(new URL(request.url).pathname).toBe("/v1/responses")
        const body: unknown = await request.json()
        expect(body).toMatchObject({ model: "CM_GPT6_Sol_High", stream: true })
        headers.push(request.headers)
        const image = {
          type: "image_generation_call",
          id: `image_${headers.length}`,
          status: "completed",
          output_format: "png",
          result: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        }
        const response = {
          id: `resp_${headers.length}`,
          object: "response",
          created_at: 0,
          status: "completed",
          model: "CM_GPT6_Sol_High",
          output: [image],
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        }
        return new Response(
          [
            { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...image, result: null, status: "in_progress" },
            },
            { type: "response.output_item.done", output_index: 0, item: image },
            { type: "response.completed", response },
          ]
            .map(
              (event, sequence_number) =>
                `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
            )
            .join(""),
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
      for (const text of ["Generate an image", "Generate another image"]) {
        await host.sessions.prompt({ sessionID: session.id, text })
        await host.sessions.wait({ sessionID: session.id })
        expect((await host.sessions.get({ sessionID: session.id })).outcome).toBe("succeeded")
        expect(
          (await host.message.list({ sessionID: session.id })).data.some(
            (message) =>
              message.type === "assistant" &&
              message.content.some(
                (part) =>
                  part.type === "tool" &&
                  part.name === "image_generation" &&
                  part.state.status === "completed" &&
                  part.state.content?.some(
                    (item) =>
                      item.type === "file" &&
                      item.mime === "image/png" &&
                      item.uri.startsWith("data:image/png;base64,"),
                  ),
              ),
          ),
        ).toBe(true)
      }
      expect(headers).toHaveLength(2)
      expect(headers[0].get("x-opencode-runtime-id")).toMatch(/^[a-f\d-]{36}$/)
      expect(headers[1].get("x-opencode-runtime-id")).toBe(headers[0].get("x-opencode-runtime-id"))
      expect(headers[0].get("x-opencode-client")).toBeTruthy()
      expect(headers.map((value) => value.get("x-opencode-request-kind"))).toEqual(["primary", "primary"])
    } finally {
      server.stop(true)
      await rm(directory, { recursive: true, force: true })
    }
  },
)

test("packaged CM plugins activate with the complete official Figma skill bundle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cm-v2-packaged-"))
  const resources = new URL("../resources/cm-plugins/", import.meta.url)
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
