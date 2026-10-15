import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Scheduler, type Adapter } from "../../src/schedule/engine"

test.each(["pause", "delete"] as const)("%s during dispatch prevents prompt admission", async (action) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cm-admission-"))
  const control = { now: Date.parse("2026-10-08T08:00:00Z"), admissions: 0 }
  const ready = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const notifications: string[] = []
  const adapter: Adapter = {
    normalize: async (definition) => ({ definition, directory }),
    authenticate: async () => true,
    requestLogin: async () => {},
    reconcile: async () => "absent",
    notify: async (item) => {
      notifications.push(item.state)
    },
    execute: async (_item, authorize) => {
      ready.resolve()
      await release.promise
      if (
        !(await authorize(async () => {
          control.admissions++
        }))
      )
        return { state: "cancelled" }
      return { state: "completed" }
    },
  }
  const engine = await new Scheduler(path.join(directory, "schedules.json"), adapter, () => control.now).open()
  const saved = await engine.put({
    schemaVersion: 1,
    name: "Admission race",
    prompt: "Check the build",
    target: { type: "existing_session", sessionID: "ses_example" },
    schedule: { type: "once", at: "2026-10-08T08:01:00Z" },
  })
  control.now += 60000
  const dispatch = engine.tick()
  try {
    await ready.promise
    if (action === "pause") await engine.pause(saved.id)
    if (action === "delete") await engine.remove(saved.id)
    release.resolve()
    await dispatch
    expect(control.admissions).toBe(0)
    const state = await engine.list()
    expect(state.schedules[0].runs).toBe(0)
    expect(state.occurrences[0].admitted).toBe(false)
    expect(state.occurrences[0].state).toBe(action === "pause" ? "pending" : "skipped")
    expect(state.occurrences[0].detail).toBe(
      action === "pause" ? "Schedule paused before admission" : "Schedule deleted before admission",
    )
    expect(notifications).toEqual([])
    await engine.close()
    const reopened = await new Scheduler(engine.file, adapter, () => control.now).open()
    try {
      await reopened.tick()
      expect(control.admissions).toBe(0)
      if (action === "pause") {
        await reopened.pause(saved.id, true)
        await reopened.tick()
        expect(control.admissions).toBe(1)
        expect((await reopened.list()).schedules[0].runs).toBe(1)
      }
      expect((await reopened.list()).occurrences[0]).toMatchObject({
        id: state.occurrences[0].id,
        sessionID: state.occurrences[0].sessionID,
        promptID: state.occurrences[0].promptID,
      })
    } finally {
      await reopened.close()
    }
  } finally {
    release.resolve()
    await dispatch
    await engine.close()
    await rm(directory, { recursive: true, force: true })
  }
})
