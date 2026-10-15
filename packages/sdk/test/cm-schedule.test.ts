import { expect, test } from "bun:test"
import { join } from "node:path"
import { CmScheduleRpc } from "@opencode/schema/cm-schedule"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { OpenCode } from "../src"

if (process.env.CM_SCHEDULER_TEST_CHILD !== "1") {
  test("CookieMonster scheduler runs inside an isolated V2 backend", async () => {
    await using root = await tmpdir("cm-v2-scheduler-process-")
    const result = Bun.spawnSync([process.execPath, "test", import.meta.path], {
      env: {
        ...process.env,
        CM_SCHEDULER_TEST_CHILD: "1",
        CM_DESKTOP: "1",
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
  test("CookieMonster scheduling admits through V2 and does not replay a completed occurrence after reopening", async () => {
    await using directory = await tmpdir("cm-v2-schedule-")
    const previous = process.env.CM_DESKTOP
    process.env.CM_DESKTOP = "1"
    let requests = 0
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        requests++
        expect(await request.json()).toMatchObject({ model: "local", stream: true })
        return new Response(
          [
            { choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ]
            .map(
              (chunk) =>
                `data: ${JSON.stringify({ id: "schedule", object: "chat.completion.chunk", created: 0, ...chunk })}\n\n`,
            )
            .join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const options = {
      database: { path: join(directory.path, "sessions.db") },
      config: {
        directory: directory.path,
        project: false,
        content: JSON.stringify({
          model: "local/local",
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
    }
    const location = { directory: directory.path }
    try {
      {
        await using host = await OpenCode.create(options)
        await host.model.list({ location })
        const rpc = host.rpc(CmScheduleRpc)
        await rpc.manage(
          {
            action: "create",
            definition: {
              schemaVersion: 1,
              name: "Scheduled V2 task",
              prompt: "Say done",
              target: {
                type: "new_session",
                directory: directory.path,
                workspace: { type: "local" },
                model: { providerID: "local", id: "local" },
              },
              schedule: { type: "once", at: new Date(Date.now() + 100).toISOString() },
            },
          },
          { location },
        )
        const state = async () =>
          await Bun.file(join(process.env.XDG_DATA_HOME!, "opencode", "scheduling", "schedules.json")).json()
        for (let attempt = 0; attempt < 80; attempt++) {
          if ((await state()).occurrences[0]?.state === "completed") break
          await Bun.sleep(100)
        }
        const completed = (await state()).occurrences[0]
        expect(completed).toMatchObject({ state: "completed", admitted: true })
        const history = await host.message.list({ sessionID: completed.sessionID })
        expect(history.data.filter((message) => message.type === "user")).toHaveLength(1)
        expect(requests).toBe(1)
      }
      {
        await using host = await OpenCode.create(options)
        await host.model.list({ location })
        await host.rpc(CmScheduleRpc).list({}, { location })
        expect(requests).toBe(1)
      }
    } finally {
      server.stop(true)
      if (previous === undefined) delete process.env.CM_DESKTOP
      else process.env.CM_DESKTOP = previous
    }
  }, 20_000)
