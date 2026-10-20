import { expect, test } from "bun:test"
import { OpenCode, type OpenCodeEvent, type SessionInfo } from "@opencode/client/promise"
import { createData, type CreateDataInput } from "@opencode/client/solid"
import { createRoot, createSignal } from "solid-js"
import { unwrap } from "solid-js/store"
import { createSessionRetention } from "@/runtime/server/session-retention"

// Runs under the browser build: the server build of Solid never runs the policy's effect.
const delay = 10

test("releases unkept families after the delay and keeps visible, running and attention families", async () => {
  const ids = ["ses_open", "ses_open_child", "ses_closed", "ses_closed_child", "ses_running", "ses_asked"]
  const scope = setup({ visible: ["ses_open_child"] })

  try {
    scope.remember("ses_open")
    scope.remember("ses_open_child", "ses_open")
    scope.remember("ses_closed")
    scope.remember("ses_closed_child", "ses_closed")
    scope.remember("ses_running")
    scope.remember("ses_asked")
    scope.data.session.setStatus("ses_running", "running")
    scope.emit(permissionAsked("ses_asked"))

    for (const id of ids) await scope.data.session.message.sync(id)
    await settle()

    expect(ids.filter(scope.cached)).toEqual(["ses_open", "ses_open_child", "ses_running", "ses_asked"])
    // Eviction drops only transcript rows.
    expect(scope.data.session.get("ses_closed_child")?.parentID).toBe("ses_closed")
    expect(scope.data.session.family("ses_closed")).toEqual(["ses_closed", "ses_closed_child"])
    expect(scope.data.session.status("ses_running")).toBe("running")
    expect(scope.data.session.permission.list("ses_asked")?.[0]?.id).toBe("per_ses_asked")

    scope.data.session.setStatus("ses_running", "idle")
    await settle()
    expect(ids.filter(scope.cached)).toEqual(["ses_open", "ses_open_child", "ses_asked"])
  } finally {
    scope.dispose()
  }
})

test("closing a child tab keeps its still-visible parent and sibling family", async () => {
  const ids = ["ses_parent", "ses_child", "ses_sibling"]
  const scope = setup({ visible: ["ses_parent", "ses_child"] })

  try {
    scope.remember("ses_parent")
    scope.remember("ses_child", "ses_parent")
    scope.remember("ses_sibling", "ses_parent")

    for (const id of ids) await scope.data.session.message.sync(id)

    scope.setVisible(["ses_parent"])
    await settle()
    expect(ids.filter(scope.cached)).toEqual(ids)

    scope.setVisible([])
    await settle()
    expect(ids.filter(scope.cached)).toEqual([])
  } finally {
    scope.dispose()
  }
})

test("waits for persisted tabs, and keeps a read that lands before its tab or navigation commits", async () => {
  const scope = setup({ ready: false })

  try {
    scope.remember("ses_opening")
    await scope.data.session.message.sync("ses_opening")
    await settle()
    expect(scope.cached("ses_opening")).toBe(true)

    // Home reads the transcript before its transition adds the tab.
    scope.setReady(true)
    scope.setVisible(["ses_opening"])
    await settle()
    expect(scope.cached("ses_opening")).toBe(true)

    scope.setNavigating(true)
    scope.setVisible([])
    await settle()
    expect(scope.cached("ses_opening")).toBe(true)

    scope.setNavigating(false)
    await settle()
    expect(scope.cached("ses_opening")).toBe(false)
  } finally {
    scope.dispose()
  }
})

test("late reads, late pages and later events are released again, and reopening reads the transcript", async () => {
  const late = Promise.withResolvers<void>()
  const older = Promise.withResolvers<void>()
  const ids = ["ses_paged", "ses_late"]

  const scope = setup({
    visible: ids,
    read(url) {
      if (url.searchParams.has("cursor")) return older.promise

      if (url.pathname.endsWith("/ses_late/message")) return late.promise

      return undefined
    },
  })

  try {
    scope.remember("ses_paged")
    scope.remember("ses_late")
    await scope.data.session.message.sync("ses_paged")
    await scope.data.session.pending.sync("ses_late")

    const reads = Promise.allSettled([
      scope.data.session.message.sync("ses_late"),
      scope.data.session.message.loadMore("ses_paged"),
    ])

    scope.setVisible([])
    await settle()
    expect(ids.filter(scope.cached)).toEqual([])

    late.resolve()
    older.resolve()
    await reads
    // Both reads publish after their family was evicted.
    expect(ids.filter(scope.cached)).toEqual(ids)
    await settle()
    expect(ids.filter(scope.cached)).toEqual([])

    scope.emit(agentSelected("ses_paged"))
    expect(scope.cached("ses_paged")).toBe(true)
    await settle()
    expect(scope.cached("ses_paged")).toBe(false)

    scope.setVisible(["ses_paged"])
    await scope.data.session.message.sync("ses_paged")
    await settle()
    expect(scope.transcriptReads("ses_paged")).toBe(2)
    expect(scope.data.session.message.list("ses_paged").map((item) => item.id)).toEqual(["msg_ses_paged"])
  } finally {
    late.resolve()
    older.resolve()
    scope.dispose()
  }
})

test.each(["echo", "reject"] as const)(
  "keeps a closed session's optimistic prompt past the deadline and releases it after its %s",
  async (mode) => {
    const answer = Promise.withResolvers<void>()

    const scope = setup({
      async read(url) {
        if (!url.pathname.endsWith("/prompt")) return undefined
        await answer.promise

        return mode === "reject"
          ? Response.json({ message: "rejected" }, { status: 400 })
          : Response.json({ id: "msg_local" })
      },
    })

    try {
      scope.remember("ses_submit")

      const prompt = Promise.allSettled([
        scope.data.session.prompt({ sessionID: "ses_submit", id: "msg_local", text: "local" }),
      ])

      await settle()
      // The deadline passed while the submission awaited its acknowledgement.
      expect(scope.data.session.message.list("ses_submit").map((item) => item.id)).toEqual(["msg_local"])

      if (mode === "echo") scope.emit(enqueued("ses_submit", "msg_local"))
      answer.resolve()
      await prompt
      await settle()
      expect(scope.cached("ses_submit")).toBe(false)
      expect(scope.data.session.pending.list("ses_submit")).toEqual([])
    } finally {
      answer.resolve()
      scope.dispose()
    }
  },
)

test("keeps a closed session's first prompt while its creation is unacknowledged, then releases it", async () => {
  const created = Promise.withResolvers<Response>()

  const scope = setup({
    read(url) {
      if (url.pathname === "/api/session") return created.promise

      if (url.pathname.endsWith("/prompt")) return Promise.resolve(Response.json({ id: "msg_first" }))

      return undefined
    },
  })

  try {
    const session = scope.data.session.create({})

    const prompt = Promise.allSettled([
      scope.data.session.prompt({ sessionID: session.id, id: "msg_first", text: "first" }),
    ])

    await settle()
    // Eviction skips a session whose creation the server has not acknowledged.
    expect(scope.data.session.message.list(session.id).map((item) => item.id)).toEqual(["msg_first"])

    created.resolve(Response.json({ data: info(session.id) }))
    await session.request
    scope.emit(enqueued(session.id, "msg_first"))
    await prompt
    await settle()
    expect(scope.cached(session.id)).toBe(false)
    expect(scope.data.session.pending.list(session.id)).toEqual([])
    expect(scope.data.session.get(session.id)?.id).toBe(session.id)
  } finally {
    scope.dispose()
  }
})

test("closed transcripts and the rows later events bring back do not stay on the heap", async () => {
  const count = 48
  const size = 512 * 1024
  const ids = Array.from({ length: count }, (_, index) => `ses_heavy_${index}`)
  const scope = setup({ text: "x".repeat(size) })

  try {
    ids.forEach((id) => scope.remember(id))
    scope.setVisible(ids)
    const base = heap()

    for (const id of ids) await scope.data.session.message.sync(id)
    const rows = ids.map((id) => new WeakRef(unwrap(scope.data.session.message.list(id))[0]!))
    const loaded = heap()

    scope.setVisible([])
    await settle()
    ids.forEach((id) => scope.emit(agentSelected(id)))
    expect(ids.filter(scope.cached)).toEqual(ids)
    await settle()
    const released = heap()

    console.info(`[session-retention heap] base=${base} loaded=${loaded} released=${released}`)
    expect(ids.filter(scope.cached)).toEqual([])
    expect(loaded - base).toBeGreaterThan(count * size * 0.8)
    expect(released - base).toBeLessThan((loaded - base) * 0.1)
    expect(rows.filter((row) => row.deref() !== undefined)).toHaveLength(0)
  } finally {
    scope.dispose()
  }
})

function settle() {
  return Bun.sleep(delay * 5)
}

function heap() {
  Bun.gc(true)

  return process.memoryUsage().heapUsed
}

function setup(
  input: {
    visible?: string[]
    ready?: boolean
    text?: string
    /** Delays a request, or answers it when the promise resolves to a response. */
    read?: (url: URL) => Promise<Response | void> | undefined
  } = {},
) {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const reads: URL[] = []

  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (request) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      reads.push(url)
      const response = await input.read?.(url)

      if (response) return response
      const sessionID = url.pathname.split("/")[3]

      if (url.pathname.endsWith("/inbox"))
        return Response.json({
          data: [
            {
              id: `inb_${sessionID}`,
              sessionID,
              type: "user",
              delivery: "steer",
              payload: { text: "pending" },
              time: { created: 2 },
            },
          ],
        })
      const older = url.searchParams.has("cursor")

      return Response.json({
        data: [
          {
            id: older ? `msg_${sessionID}_older` : `msg_${sessionID}`,
            type: "user",
            text: input.text ?? "transcript",
            time: { created: older ? 0 : 1 },
          },
        ],
        cursor: older ? {} : { next: "older" },
      })
    },
  })

  return createRoot((dispose) => {
    const data = createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)

          return () => listeners.delete(handler)
        },
      },
    })

    const [visible, setVisible] = createSignal<readonly string[]>(input.visible ?? [])
    const [ready, setReady] = createSignal(input.ready ?? true)
    const [navigating, setNavigating] = createSignal(false)
    createSessionRetention({ session: data.session, ready, visible, navigating, delay })

    return {
      data,
      dispose,
      setVisible,
      setReady,
      setNavigating,
      emit: (details: OpenCodeEvent) => listeners.forEach((listener) => listener({ name: details.type, details })),
      remember: (id: string, parentID?: string) => data.session.remember(info(id, parentID)),
      cached: (id: string) => data.session.message.list(id).length > 0,
      // Reads of the newest transcript page, not of older pages.
      transcriptReads: (id: string) =>
        reads.filter((url) => url.pathname.endsWith(`/${id}/message`) && !url.searchParams.has("cursor")).length,
    }
  })
}

function info(id: string, parentID?: string): SessionInfo {
  return {
    id,
    parentID,
    projectID: "project",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    location: { directory: "/project" },
  }
}

function agentSelected(sessionID: string): OpenCodeEvent {
  return {
    id: `evt_agent_${sessionID}`,
    created: 1,
    type: "session.agent.selected",
    durable: { aggregateID: sessionID, seq: 1, version: 1 },
    data: { sessionID, agent: "build" },
  }
}

function permissionAsked(sessionID: string): OpenCodeEvent {
  return {
    id: `evt_permission_${sessionID}`,
    created: 1,
    type: "permission.asked",
    data: { id: `per_${sessionID}`, sessionID, action: "bash", resources: ["bun test"] },
  }
}

function enqueued(sessionID: string, inboxID: string): OpenCodeEvent {
  return {
    id: `evt_${inboxID}`,
    created: 1,
    type: "session.inbox.enqueued",
    durable: { aggregateID: sessionID, seq: 1, version: 1 },
    data: { sessionID, inboxID, item: { type: "user", delivery: "steer", payload: { text: "echoed" } } },
  }
}
