import { expect, test } from "bun:test"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { OpenCode } from "../src"
import { tmpdir } from "../../core/test/fixture/tmpdir"

if (process.env.CM_AE_TEST_CHILD !== "1") {
  test("AE tools execute through native V2 in an isolated backend", async () => {
    await using root = await tmpdir("cm-v2-ae-process-")
    const result = Bun.spawnSync([process.execPath, "test", import.meta.path], {
      env: {
        ...process.env,
        CM_AE_TEST_CHILD: "1",
        CM_DESKTOP: "1",
        CM_AE_VERSION: "2.0.29",
        CM_AE_PLUGIN_URL: pathToFileURL(join(import.meta.dir, "../../desktop/vendor/cm-ae/plugin.mjs")).href,
        CM_AE_DATA_DIR: join(root.path, "ae"),
        XDG_DATA_HOME: join(root.path, "data"),
        XDG_CONFIG_HOME: join(root.path, "config"),
        XDG_CACHE_HOME: join(root.path, "cache"),
        XDG_STATE_HOME: join(root.path, "state"),
        OPENCODE_TEST_HOME: root.path,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 25_000,
    })
    expect(result.exitCode, Buffer.concat([result.stdout, result.stderr]).toString()).toBe(0)
  }, 30_000)
} else
  test("V2 preserves AE tools and checkpoint-backed runtime without loading the old plugin API", async () => {
    await using root = await tmpdir("cm-v2-ae-")
    let requests = 0
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests++
        const body = await request.json()
        if (requests === 1)
          expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toContain("ae_restore")
        if (requests === 2)
          expect(
            body.messages.some(
              (message: { role: string; content: string }) => message.role === "tool" && message.content === "[]",
            ),
          ).toBe(true)
        const delta =
          requests === 1
            ? {
                role: "assistant",
                tool_calls: [
                  { index: 0, id: "ae-read", type: "function", function: { name: "ae_connections", arguments: "{}" } },
                ],
              }
            : { role: "assistant", content: "No AE instances are connected." }
        const chunks = [
          { choices: [{ index: 0, delta, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: requests === 1 ? "tool_calls" : "stop" }] },
        ]
        return new Response(
          chunks
            .map(
              (chunk) =>
                `data: ${JSON.stringify({ id: "ae-test", object: "chat.completion.chunk", created: 0, ...chunk })}\n\n`,
            )
            .join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    try {
      await using host = await OpenCode.create({
        database: { path: join(root.path, "sessions.db") },
        config: {
          directory: root.path,
          project: false,
          content: JSON.stringify({
            model: "local/local",
            plugins: ["-opencode.browser"],
            providers: {
              local: {
                package: "@opencode/ai/providers/openai-compatible",
                settings: { baseURL: `${server.url}v1`, apiKey: "local" },
                models: { local: {} },
              },
            },
          }),
        },
        models: { fetch: false },
        fs: { filewatcher: false },
      })
      const session = await host.session.create({ title: "AE transport", location: { directory: root.path } })
      await host.model.list({ location: { directory: root.path } })
      expect(
        (await host.plugin.list({ location: { directory: root.path } })).data.find(
          (plugin) => plugin.id === "cookiemonster.ae",
        )?.state,
      ).toEqual({ status: "active" })
      await host.session.prompt({ sessionID: session.id, text: "List the connected After Effects instances." })
      await host.session.wait({ sessionID: session.id })
      expect((await host.session.get({ sessionID: session.id })).outcome).toBe("succeeded")
      const history = await host.message.list({ sessionID: session.id })
      expect(
        history.data.some(
          (message) =>
            message.type === "assistant" &&
            message.content.some(
              (part) => part.type === "tool" && part.name === "ae_connections" && part.state.status === "completed",
            ),
        ),
      ).toBe(true)
      expect(requests).toBe(2)
      const descriptor = await Bun.file(join(process.env.CM_AE_DATA_DIR!, "descriptor.json")).json()
      const refused = await fetch(`http://127.0.0.1:${descriptor.port}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      expect(refused.status).toBe(401)
    } finally {
      server.stop(true)
    }
  }, 20_000)
