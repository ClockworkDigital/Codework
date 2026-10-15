// SAFETY: The synthetic WebContents emits real CDP wire events into the production witness.
/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion */
import { describe, expect, test, setSystemTime } from "bun:test"
import { EventEmitter } from "node:events"
import type { WebContents } from "electron"
import {
  createCdpNetworkReducer,
  installNetworkWitness,
  reduceCdpNetworkEvent,
  summarizeCdpWindow,
} from "./cdp-network-recorder"

test("generated artifacts wait for async resources and remain scoped to the submitted job", async () => {
  const dbg = Object.assign(new EventEmitter(), { isAttached: () => true, sendCommand: async () => ({}) })
  const contents = { debugger: dbg } as unknown as WebContents
  const witness = await installNetworkWitness(contents)
  const url = "https://wpp-ai-base-prd-persistentdatabucket.s3.eu-west-1.amazonaws.com/resource/test/"
  const request = (name: string) =>
    dbg.emit(
      "message",
      {},
      "Network.requestWillBeSent",
      { request: { method: "GET", url: `${url}${name}.png?X-Amz-Signature=test` } },
      "iframe-1",
    )

  try {
    setSystemTime(1000)
    request("previous-job")
    setSystemTime(2000)
    dbg.emit(
      "message",
      {},
      "Network.requestWillBeSent",
      {
        requestId: "resource",
        request: { method: "POST", url: "https://open-web-assistant-cs.wpp.ai/v1/tools/image/results/job/resources" },
      },
      "iframe-1",
    )
    const pending = witness.collectArtifacts(1500)
    setSystemTime(2100)
    request("first")
    request("first")
    setSystemTime(2300)
    request("second")
    setSystemTime(4000)
    dbg.emit("message", {}, "Network.loadingFinished", { requestId: "resource" }, "iframe-1")
    expect((await pending).map((artifact) => artifact.fileName)).toEqual(["first.png", "second.png"])
    expect(witness.summarizeWindow(1500).cdpRequestSeen).toBe(false)
    await expect(witness.collectArtifacts(1500, AbortSignal.abort())).rejects.toBeDefined()
  } finally {
    setSystemTime()
  }
})

for (const status of ["AVAILABLE", "FAILED"]) {
  test(`observes the resource job's terminal ${status} result even before the page fetches an image`, async () => {
    const url =
      "https://wpp-ai-base-prd-persistentdatabucket.s3.eu-west-1.amazonaws.com/resource/image/0.png?X-Amz-Signature=test"
    const bodies = [
      { data: { resourceId: "image-job", status: "IN_PROGRESS" } },
      { data: { resourceId: "image-job", status, output: { success: [url], fail: "No images were generated" } } },
    ]
    const dbg = Object.assign(new EventEmitter(), {
      isAttached: () => true,
      sendCommand: async () => ({ body: JSON.stringify(bodies.shift()) }),
    })
    const witness = await installNetworkWitness({ debugger: dbg } as unknown as WebContents)
    const poll = () => {
      dbg.emit(
        "message",
        {},
        "Network.requestWillBeSent",
        {
          requestId: "poll",
          request: {
            method: "POST",
            url: "https://open-web-agent-builder-cs.wpp.ai/v1/tools/project/results/chat/resources",
          },
        },
        "iframe-1",
      )
      dbg.emit("message", {}, "Network.loadingFinished", { requestId: "poll" }, "iframe-1")
    }

    try {
      setSystemTime(1000)
      poll()
      await Promise.resolve()
      await Promise.resolve()
      const pending = witness.collectArtifacts(500)
      setSystemTime(2000)
      poll()
      await Promise.resolve()
      await Promise.resolve()
      setSystemTime(4000)
      if (status === "FAILED")
        await expect(pending).rejects.toMatchObject({
          type: "wpp_image_generation_failed",
          message: "No images were generated",
        })
      if (status === "AVAILABLE") expect((await pending).map((artifact) => artifact.url)).toEqual([url])
    } finally {
      setSystemTime()
    }
  })
}

test("ignores abandoned jobs for partial streamed artifact prompts and keeps equal filenames from final jobs", async () => {
  const url = "https://wpp-ai-base-prd-persistentdatabucket.s3.eu-west-1.amazonaws.com/resource/"
  const prompts = ["A single blue circle.", "A single green square."]
  const bodies = [
    { data: { resourceId: "partial", status: "IN_PROGRESS" } },
    ...prompts.map((_, index) => ({
      data: {
        resourceId: `final-${index}`,
        status: "AVAILABLE",
        output: { success: [`${url}${index}/0.png?X-Amz-Signature=test`] },
      },
    })),
  ]
  const dbg = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    sendCommand: async () => ({ body: JSON.stringify(bodies.shift()) }),
  })
  const witness = await installNetworkWitness({ debugger: dbg } as unknown as WebContents)

  try {
    setSystemTime(1000)
    for (const prompt of ["A single", ...prompts]) {
      dbg.emit(
        "message",
        {},
        "Network.requestWillBeSent",
        {
          requestId: prompt,
          request: {
            method: "POST",
            url: "https://open-web-assistant-cs.wpp.ai/v1/tools/project/results/chat/resources",
            postData: JSON.stringify({ input: { prompt } }),
          },
        },
        "iframe-1",
      )
      dbg.emit("message", {}, "Network.loadingFinished", { requestId: prompt }, "iframe-1")
      await Promise.resolve()
      await Promise.resolve()
    }
    setSystemTime(4000)
    const result = await witness.collectArtifacts(500, AbortSignal.timeout(1000), 1000, prompts)
    expect(result.map((artifact) => artifact.fileName)).toEqual(["0.png", "0.png"])
    expect(result.map((artifact) => new URL(artifact.url).pathname)).toEqual(["/resource/0/0.png", "/resource/1/0.png"])
  } finally {
    setSystemTime()
  }
})

describe("cdp network reducer", () => {
  test("summarizes a completed model request", () => {
    const records = []

    reduceCdpNetworkEvent(
      records,
      "Network.requestWillBeSent",
      {
        requestId: "1",
        type: "Fetch",
        initiator: { type: "script" },
        request: { method: "POST", url: "https://open-web-assistant-cs.wpp.ai/v1/chat/completions" },
      },
      100,
    )
    reduceCdpNetworkEvent(
      records,
      "Network.responseReceived",
      {
        requestId: "1",
        response: { status: 200, mimeType: "text/event-stream" },
      },
      110,
    )
    reduceCdpNetworkEvent(
      records,
      "Network.dataReceived",
      {
        requestId: "1",
        dataLength: 5,
        encodedDataLength: 7,
      },
      120,
    )
    reduceCdpNetworkEvent(records, "Network.eventSourceMessageReceived", { requestId: "1" }, 130)
    reduceCdpNetworkEvent(
      records,
      "Network.loadingFinished",
      {
        requestId: "1",
        encodedDataLength: 9,
      },
      140,
    )

    expect(summarizeCdpWindow(records, 90)).toMatchObject({
      cdpRequestSeen: true,
      cdpStatus: 200,
      cdpBytes: 9,
      cdpFinished: true,
      cdpFailed: false,
      eventSourceMessages: 1,
      requestCount: 1,
      requestType: "Fetch",
      mimeType: "text/event-stream",
      initiatorType: "script",
      targetType: "page",
    })
  })

  test("attributes a worker-issued request to its target kind", () => {
    const reducer = createCdpNetworkReducer(() => 100)

    reducer.handle("Target.attachedToTarget", {
      sessionId: "S1",
      targetInfo: { type: "worker" },
    })
    reducer.handle(
      "Network.requestWillBeSent",
      {
        requestId: "1",
        type: "Fetch",
        request: { method: "POST", url: "https://abc.lambda-url.eu-west-1.on.aws/" },
      },
      "S1",
    )
    reducer.handle("Network.loadingFinished", { requestId: "1", encodedDataLength: 9 }, "S1")

    expect(reducer.summarizeWindow(90)).toMatchObject({
      cdpRequestSeen: true,
      cdpFinished: true,
      targetType: "worker",
    })
  })

  test("records failed model requests", () => {
    const records = []

    reduceCdpNetworkEvent(
      records,
      "Network.requestWillBeSent",
      {
        requestId: "1",
        request: { method: "POST", url: "https://open-web-assistant-cs.wpp.ai/v1/chat/completions" },
      },
      100,
    )
    reduceCdpNetworkEvent(
      records,
      "Network.loadingFailed",
      {
        requestId: "1",
        errorText: "net::ERR_ABORTED",
      },
      120,
    )

    expect(summarizeCdpWindow(records, 90)).toMatchObject({
      cdpRequestSeen: true,
      cdpFailed: true,
      failureText: "net::ERR_ABORTED",
    })
  })

  test("summarizes the SSE completion, not a trailing telemetry beacon", () => {
    const records = []

    // The model completion: text/event-stream, streamed bytes, finished 200.
    reduceCdpNetworkEvent(
      records,
      "Network.requestWillBeSent",
      {
        requestId: "completion",
        type: "Fetch",
        request: { method: "POST", url: "https://abc.lambda-url.eu-west-1.on.aws/" },
      },
      100,
    )
    reduceCdpNetworkEvent(
      records,
      "Network.responseReceived",
      {
        requestId: "completion",
        response: { status: 200, mimeType: "text/event-stream" },
      },
      110,
    )
    reduceCdpNetworkEvent(records, "Network.loadingFinished", { requestId: "completion", encodedDataLength: 1190 }, 120)

    // A trailing telemetry beacon fired AFTER the completion: tiny text/plain 204. This is what
    // .at(-1) used to pick.
    reduceCdpNetworkEvent(
      records,
      "Network.requestWillBeSent",
      {
        requestId: "beacon",
        type: "Fetch",
        request: { method: "POST", url: "https://abc.lambda-url.eu-west-1.on.aws/" },
      },
      130,
    )
    reduceCdpNetworkEvent(
      records,
      "Network.responseReceived",
      {
        requestId: "beacon",
        response: { status: 204, mimeType: "text/plain" },
      },
      140,
    )
    reduceCdpNetworkEvent(records, "Network.loadingFinished", { requestId: "beacon", encodedDataLength: 49 }, 150)

    expect(summarizeCdpWindow(records, 90)).toMatchObject({
      cdpRequestSeen: true,
      cdpStatus: 200,
      cdpBytes: 1190,
      mimeType: "text/event-stream",
      requestCount: 2,
    })
  })

  test("surfaces a failed completion over a finished beacon", () => {
    const records = []

    // Completion fails (no response / aborted).
    reduceCdpNetworkEvent(
      records,
      "Network.requestWillBeSent",
      {
        requestId: "completion",
        request: { method: "POST", url: "https://abc.lambda-url.eu-west-1.on.aws/" },
      },
      100,
    )
    reduceCdpNetworkEvent(
      records,
      "Network.loadingFailed",
      { requestId: "completion", errorText: "net::ERR_FAILED" },
      110,
    )

    // A later beacon finishes fine — must NOT mask the failure.
    reduceCdpNetworkEvent(
      records,
      "Network.requestWillBeSent",
      {
        requestId: "beacon",
        request: { method: "POST", url: "https://abc.lambda-url.eu-west-1.on.aws/" },
      },
      120,
    )
    reduceCdpNetworkEvent(
      records,
      "Network.responseReceived",
      {
        requestId: "beacon",
        response: { status: 204, mimeType: "text/plain" },
      },
      130,
    )
    reduceCdpNetworkEvent(records, "Network.loadingFinished", { requestId: "beacon", encodedDataLength: 49 }, 140)

    expect(summarizeCdpWindow(records, 90)).toMatchObject({
      cdpRequestSeen: true,
      cdpFailed: true,
      failureText: "net::ERR_FAILED",
    })
  })

  test("ignores filtered telemetry and tool requests", () => {
    const records = []

    reduceCdpNetworkEvent(
      records,
      "Network.requestWillBeSent",
      {
        requestId: "1",
        request: { method: "POST", url: "https://datadoghq.example/v1/input" },
      },
      100,
    )
    reduceCdpNetworkEvent(
      records,
      "Network.requestWillBeSent",
      {
        requestId: "2",
        request: { method: "POST", url: "https://open-web-assistant-cs.wpp.ai/v1/tools/list" },
      },
      110,
    )

    expect(summarizeCdpWindow(records, 90).cdpRequestSeen).toBe(false)
  })
})
