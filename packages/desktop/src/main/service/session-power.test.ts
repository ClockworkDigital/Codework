import { expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { SessionPower } from "./session-power"

for (const terminal of [
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.deleted",
]) {
  test(`holds one sleep blocker through tools, retries and overlapping runs until ${terminal}`, async () => {
    const fixture = serve()
    const fiber = Effect.runFork(Effect.scoped(SessionPower.watch(fixture.endpoint, fixture.blocker)))

    try {
      await until(() => fixture.snapshots.length === 1)
      await fixture.send("session.execution.started", "first")
      await until(() => fixture.calls.length === 1)
      await fixture.send("session.execution.started", "first")
      await fixture.send("session.execution.started", "second")
      await fixture.send("session.step.ended", "first")
      await fixture.send("session.tool.called", "first")
      await fixture.send("session.tool.success", "first")
      await fixture.send("session.retry.scheduled", "first")
      await fixture.send(terminal, "first")
      expect(fixture.calls).toEqual(["start:prevent-app-suspension"])
      await fixture.send(terminal, "second")
      await until(() => fixture.calls.length === 2)
      expect(fixture.calls).toEqual(["start:prevent-app-suspension", "stop:1"])
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber))
      fixture.server.stop(true)
    }

    expect(fixture.calls).toHaveLength(2)
  })
}

test("adopts active runs on connection and releases the blocker when its scope closes", async () => {
  const fixture = serve()
  fixture.snapshot.read = async () => ({ existing: { type: "running" } })
  const fiber = Effect.runFork(Effect.scoped(SessionPower.watch(fixture.endpoint, fixture.blocker)))

  try {
    await until(() => fixture.calls.length === 1)
    expect(fixture.snapshots).toEqual([`Basic ${Buffer.from("opencode:secret").toString("base64")}`])
    expect(fixture.calls).toEqual(["start:prevent-app-suspension"])
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber))
    fixture.server.stop(true)
  }

  expect(fixture.calls).toEqual(["start:prevent-app-suspension", "stop:1"])
})

test("execution boundaries queued during hydration supersede a stale active snapshot", async () => {
  const fixture = serve()
  const snapshot = Promise.withResolvers<Record<string, { type: "running" }>>()
  fixture.snapshot.read = () => snapshot.promise
  const fiber = Effect.runFork(Effect.scoped(SessionPower.watch(fixture.endpoint, fixture.blocker)))

  try {
    await until(() => fixture.snapshots.length === 1)
    await fixture.send("session.execution.succeeded", "previous")
    await fixture.send("session.execution.started", "next")
    snapshot.resolve({ previous: { type: "running" } })
    await until(() => fixture.calls.length === 3)
    expect(fixture.calls).toEqual(["start:prevent-app-suspension", "stop:1", "start:prevent-app-suspension"])
    await fixture.send("session.execution.succeeded", "next")
    await until(() => fixture.calls.length === 4)
    expect(fixture.calls.at(-1)).toBe("stop:2")
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber))
    fixture.server.stop(true)
  }
})

test("a disconnected feed releases its blocker and reconnects with a fresh active snapshot", async () => {
  const fixture = serve()
  fixture.snapshot.read = async () => ({ existing: { type: "running" } })
  const fiber = Effect.runFork(Effect.scoped(SessionPower.watch(fixture.endpoint, fixture.blocker)))

  try {
    await until(() => fixture.calls.length === 1)
    fixture.streams[0].close()
    await until(() => fixture.calls.length === 2)
    expect(fixture.calls.at(-1)).toBe("stop:1")
    await until(() => fixture.calls.length === 3)
    expect(fixture.snapshots).toHaveLength(2)
    await fixture.send("session.execution.interrupted", "existing")
    await until(() => fixture.calls.length === 4)
    expect(fixture.calls.at(-1)).toBe("stop:2")
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber))
    fixture.server.stop(true)
  }
})

function serve() {
  const calls: string[] = []
  const streams: ReadableStreamDefaultController<Uint8Array>[] = []
  const snapshots: (string | null)[] = []
  const snapshot = { read: async (): Promise<Record<string, { type: "running" }>> => ({}) }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/api/session/active") {
        snapshots.push(request.headers.get("authorization"))

        return Response.json({ data: await snapshot.read() })
      }

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streams.push(controller)
            controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'))
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })

  let id = 0

  return {
    server,
    snapshot,
    snapshots,
    streams,
    calls,
    endpoint: { url: server.url.origin, password: "secret" },
    blocker: {
      start(type: "prevent-app-suspension" | "prevent-display-sleep") {
        calls.push(`start:${type}`)

        return ++id
      },
      stop(blockerID: number) {
        calls.push(`stop:${blockerID}`)

        return true
      },
    },
    async send(type: string, sessionID: string) {
      streams.at(-1)!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data: { sessionID } })}\n\n`))
      await Bun.sleep(10)
    },
  }
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000

  while (!check() && Date.now() < deadline) await Bun.sleep(5)
  expect(check()).toBe(true)
}
