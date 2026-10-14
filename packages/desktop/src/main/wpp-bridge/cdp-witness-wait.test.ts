import { describe, expect, test } from "bun:test"
import { awaitCdpWitnessSettle, shouldAwaitCdpFinish } from "./cdp-witness-wait"
import type { CdpNetworkSummary } from "./capture-verdict"

function witness(partial: Partial<CdpNetworkSummary>): CdpNetworkSummary {
  return {
    cdpRequestSeen: true,
    cdpStatus: 200,
    cdpBytes: 0,
    cdpFinished: false,
    cdpFailed: false,
    failureText: null,
    eventSourceMessages: 0,
    ...partial,
  }
}

describe("shouldAwaitCdpFinish", () => {
  test("waits only for unfinished corroborated requests on non-network results", () => {
    expect(shouldAwaitCdpFinish({ ok: false }, witness({}))).toBe(true)
    expect(shouldAwaitCdpFinish({ responseSource: "dom" }, witness({}))).toBe(true)
    expect(shouldAwaitCdpFinish({ responseSource: "network" }, witness({}))).toBe(false)
    expect(shouldAwaitCdpFinish({ ok: false }, witness({ cdpFinished: true }))).toBe(false)
    expect(shouldAwaitCdpFinish({ ok: false }, witness({ cdpFailed: true }))).toBe(false)
    expect(shouldAwaitCdpFinish({ ok: false }, witness({ cdpRequestSeen: false }))).toBe(false)
  })
})

describe("awaitCdpWitnessSettle", () => {
  test("returns when the witness finishes after advancing bytes", async () => {
    let clock = 0
    const samples = [
      witness({ cdpBytes: 40 }),
      witness({ cdpBytes: 125 }),
      witness({ cdpBytes: 200, cdpFinished: true }),
    ]
    let i = 0
    const settled = await awaitCdpWitnessSettle(() => samples[Math.min(i++, samples.length - 1)]!, {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      pollMs: 100,
      stallMs: 2000,
      timeoutMs: 12000,
    })
    expect(settled).toMatchObject({ cdpBytes: 200, cdpFinished: true })
  })

  test("exits on bytes stall without waiting the full timeout", async () => {
    let clock = 0
    const settled = await awaitCdpWitnessSettle(() => witness({ cdpBytes: 125 }), {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      pollMs: 250,
      stallMs: 2000,
      timeoutMs: 12000,
    })
    expect(settled).toMatchObject({ cdpBytes: 125, cdpFinished: false })
    expect(clock).toBeLessThan(4000)
  })

  test("returns immediately when the first summarize is already finished", async () => {
    let sleeps = 0
    const settled = await awaitCdpWitnessSettle(() => witness({ cdpBytes: 9, cdpFinished: true }), {
      sleep: async () => {
        sleeps += 1
      },
    })
    expect(settled.cdpFinished).toBe(true)
    expect(sleeps).toBe(0)
  })
})
