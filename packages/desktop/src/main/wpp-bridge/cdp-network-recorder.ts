import type { WebContents } from "electron"
import { installInRootAndChildTargets } from "./cdp-targets"
import { isWppModelRequest } from "./model-request-filter"
import type { CdpNetworkSummary } from "./capture-verdict"
import { parseWppArtifact, parseWppResource, wppResourcePrompt } from "./artifact-capture"

type CdpRecord = {
  key: string
  requestId: string
  firstSeenAt: number
  updatedAt: number
  url: string
  method: string
  status: number | null
  bytes: number
  finished: boolean
  failed: boolean
  failureText: string | null
  eventSourceMessages: number
  // Diagnostics for recorder_parser_miss: the CDP resource type ("Fetch"/"XHR"/"Document"/…), the
  // response mimeType, the request initiator type, and the kind of target that issued it
  // ("page"/"iframe"/"worker"/"service_worker"/…). Together with pageRecorderRequestSeen these tell
  // whether the page recorder was structurally blind (worker/service_worker), never armed in a
  // patchable frame (iframe/page + recorderSawRequest=false), or saw the request but failed to parse.
  type: string | null
  mimeType: string | null
  initiatorType: string | null
  targetType: string | null
}

const MAX_RECORDS = 100

export type NetworkWitness = {
  summarizeWindow: (sinceMs: number) => CdpNetworkSummary
  collectArtifacts: (
    sinceMs: number,
    signal?: AbortSignal,
    timeoutMs?: number,
    prompts?: readonly string[],
  ) => Promise<NonNullable<ReturnType<typeof parseWppArtifact>>[]>
}

// Register Network.enable on the shared target hub. Caller must armTargetAttach after all
// installers are registered so child iframes get the witness before they run.
export async function installNetworkWitness(contents: WebContents): Promise<NetworkWitness> {
  const dbg = contents.debugger
  const reducer = createCdpNetworkReducer()
  const artifacts = new Map<string, { started: number; artifact: NonNullable<ReturnType<typeof parseWppArtifact>> }>()
  const requests = new Map<string, { started: number; prompt?: string }>()
  const reading = new Set<Promise<void>>()
  const resources = new Map<
    string,
    { started: number; prompt?: string; resource: NonNullable<ReturnType<typeof parseWppResource>> }
  >()
  let resourceStarted = 0
  let artifactUpdated = 0

  dbg.on("message", (_event, method, params, sessionId) => {
    reducer.handle(method, params, typeof sessionId === "string" ? sessionId : undefined)
    const key = `${sessionId ?? ""}:${params.requestId}`
    if (method === "Network.loadingFinished" && requests.has(key)) {
      const request = requests.get(key)!
      requests.delete(key)
      const pending = dbg
        .sendCommand("Network.getResponseBody", { requestId: params.requestId }, sessionId)
        .then(
          (body) => {
            const resource = parseWppResource(body.body)
            if (!resource) return
            resources.set(resource.id, { ...request, resource })
            for (const artifact of resource.artifacts)
              artifacts.set(new URL(artifact.url).pathname, { started: request.started, artifact })
            if (resources.size > MAX_RECORDS) resources.delete(resources.keys().next().value!)
          },
          () => {},
        )
        .finally(() => reading.delete(pending))
      reading.add(pending)
    }
    if (method === "Network.loadingFailed") requests.delete(key)
    if (method !== "Network.requestWillBeSent") return
    const value = params as { request?: { url?: string; method?: string; postData?: string } }
    const request = value.request
    if (!request?.url) return
    const url = URL.parse(request.url)
    if (
      request.method === "POST" &&
      url?.hostname.endsWith(".wpp.ai") &&
      /^\/v1\/tools\/.+\/results\/.+\/resources/.test(url.pathname)
    ) {
      resourceStarted = Date.now()
      requests.set(key, { started: resourceStarted, prompt: wppResourcePrompt(request.postData ?? "") })
    }
    const artifact = request.method === "GET" ? parseWppArtifact(request.url) : null
    if (!artifact) return
    artifactUpdated = Date.now()
    artifacts.set(new URL(artifact.url).pathname, { started: artifactUpdated, artifact })
    if (artifacts.size > MAX_RECORDS) artifacts.delete(artifacts.keys().next().value!)
  })

  await installInRootAndChildTargets(contents, async (sessionId) => {
    await dbg.sendCommand("Network.enable", {}, sessionId)
  })

  return {
    summarizeWindow: (sinceMs) => reducer.summarizeWindow(sinceMs),
    collectArtifacts: async (sinceMs, signal, timeoutMs = 120_000, prompts = []) => {
      signal?.throwIfAborted()
      const started = Date.now()
      // Resource jobs outlive the model stream; their output URLs can arrive before the page displays an image.
      while (resourceStarted >= sinceMs || prompts.length > 0) {
        signal?.throwIfAborted()
        // WPP starts and abandons jobs for partial streamed prompts. Only the final artifact prompts own this response.
        const belongs = (entry: { started: number; prompt?: string }) =>
          entry.started >= sinceMs &&
          (!prompts.length || (entry.prompt !== undefined && prompts.includes(entry.prompt)))
        const current = Array.from(resources.values()).filter(belongs)
        const pending =
          reading.size > 0 ||
          Array.from(requests.values()).some(belongs) ||
          current.some((entry) => entry.resource.status === "IN_PROGRESS") ||
          prompts.some((prompt) => !current.some((entry) => entry.prompt === prompt))
        if (!pending && Date.now() - Math.max(resourceStarted, artifactUpdated) >= 1500) {
          const failed = current.find((entry) => entry.resource.status === "FAILED")
          if (failed)
            throw Object.assign(new Error(failed.resource.error ?? "WPP image generation failed."), {
              type: "wpp_image_generation_failed",
              statusCode: 502,
            })
          if (prompts.length) return current.flatMap((entry) => entry.resource.artifacts)
          break
        }
        if (Date.now() - started >= timeoutMs)
          throw Object.assign(new Error("WPP generated images did not become available before the request deadline."), {
            type: "wpp_image_timeout",
            statusCode: 504,
          })
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      return Array.from(artifacts.values())
        .filter((entry) => entry.started >= sinceMs)
        .map((entry) => entry.artifact)
    },
  }
}

export function createCdpNetworkReducer(now = () => Date.now()) {
  const records: CdpRecord[] = []
  // sessionId -> target kind ("page"/"iframe"/"worker"/"service_worker"/…), learned from
  // Target.attachedToTarget. Lets a witnessed request report which target issued it, so a
  // worker-issued model POST (patch unreachable) is distinguishable from an iframe/page miss
  // (patchable but not armed) or a parse miss (recorderSawRequest=true).
  const sessionTargets = new Map<string, string>()

  return {
    handle(method: string, params: unknown, sessionId?: string) {
      if (method === "Target.attachedToTarget") {
        const value = params && typeof params === "object" ? (params as Record<string, unknown>) : {}
        const childSessionId = typeof value.sessionId === "string" ? value.sessionId : ""

        const info =
          value.targetInfo && typeof value.targetInfo === "object" ? (value.targetInfo as { type?: string }) : {}

        if (childSessionId && info.type) sessionTargets.set(childSessionId, String(info.type))

        return
      }

      reduceCdpNetworkEvent(records, method, params, now(), sessionId, sessionTargets)

      if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS)
    },
    summarizeWindow(sinceMs: number) {
      return summarizeCdpWindow(records, sinceMs)
    },
    records,
  }
}

export function reduceCdpNetworkEvent(
  records: CdpRecord[],
  method: string,
  params: unknown,
  ts: number,
  sessionId = "",
  sessionTargets?: Map<string, string>,
) {
  const value = params && typeof params === "object" ? (params as Record<string, unknown>) : {}
  const key = requestKey(value.requestId, sessionId)

  if (!key) return

  if (method === "Network.requestWillBeSent") {
    const request =
      value.request && typeof value.request === "object" ? (value.request as { url?: string; method?: string }) : {}

    if (!isWppModelRequest(request)) return

    const initiator =
      value.initiator && typeof value.initiator === "object" ? (value.initiator as { type?: string }) : {}

    records.push({
      key,
      requestId: String(value.requestId),
      firstSeenAt: ts,
      updatedAt: ts,
      url: String(request.url || ""),
      method: String(request.method || "GET").toUpperCase(),
      status: null,
      bytes: 0,
      finished: false,
      failed: false,
      failureText: null,
      eventSourceMessages: 0,
      type: value.type ? String(value.type) : null,
      mimeType: null,
      initiatorType: initiator.type ? String(initiator.type) : null,
      targetType: sessionTargets?.get(sessionId) ?? (sessionId ? "child" : "page"),
    })

    return
  }

  const record = records.find((candidate) => candidate.key === key)

  if (!record) return

  record.updatedAt = ts

  if (method === "Network.responseReceived") {
    const response =
      value.response && typeof value.response === "object"
        ? (value.response as { status?: number; mimeType?: string })
        : {}

    record.status = Number(response.status) || record.status

    if (response.mimeType) record.mimeType = String(response.mimeType)

    return
  }

  if (method === "Network.dataReceived") {
    record.bytes += Number(value.encodedDataLength ?? value.dataLength) || 0

    return
  }

  if (method === "Network.eventSourceMessageReceived") {
    record.eventSourceMessages += 1

    return
  }

  if (method === "Network.loadingFinished") {
    record.finished = true
    record.bytes = Math.max(record.bytes, Number(value.encodedDataLength) || 0)

    return
  }

  if (method === "Network.loadingFailed") {
    record.failed = true
    record.failureText = String(value.errorText || "Network request failed.")
  }
}

export function summarizeCdpWindow(records: CdpRecord[], sinceMs: number): CdpNetworkSummary {
  const relevant = records.filter((record) => record.firstSeenAt >= sinceMs)
  const record = selectPrimaryRecord(relevant)

  return {
    cdpRequestSeen: Boolean(record),
    cdpStatus: record?.status || null,
    cdpBytes: record?.bytes || 0,
    cdpFinished: record?.finished === true,
    cdpFailed: record?.failed === true,
    failureText: record?.failureText || null,
    eventSourceMessages: record?.eventSourceMessages || 0,
    requestCount: relevant.length,
    url: record?.url || null,
    method: record?.method || null,
    requestType: record?.type || null,
    mimeType: record?.mimeType || null,
    initiatorType: record?.initiatorType || null,
    targetType: record?.targetType || null,
  }
}

// A WPP turn fires several model-matching POSTs (observed: 4–5), of which the model completion is
// the SSE stream and the rest are short telemetry beacons (small text/plain 204s) — and a beacon is
// usually LAST. Picking .at(-1) therefore described a beacon, not the stream: cdpBytes/cdpMimeType
// pointed at the wrong request, and a completion that FAILED could be masked by a beacon that
// finished (misclassifying wpp_request_failed as recorder_parser_miss). Select the request that
// represents the model response instead: a failed one first (so a real failure surfaces over a
// finished beacon), then the stream (SSE mime / eventSource frames), then the byte-heaviest.
function selectPrimaryRecord(relevant: CdpRecord[]): CdpRecord | undefined {
  if (relevant.length === 0) return undefined
  const stream = relevant.filter(isStreamLikeRecord)
  const pool = stream.length > 0 ? stream : relevant
  const failed = pool.filter((record) => record.failed)

  if (failed.length > 0) return failed.at(-1)

  return pool.reduce((best, record) => (record.bytes >= best.bytes ? record : best))
}

function isStreamLikeRecord(record: CdpRecord): boolean {
  return (
    String(record.mimeType || "")
      .toLowerCase()
      .includes("event-stream") || record.eventSourceMessages > 0
  )
}

function requestKey(requestId: unknown, sessionId: string) {
  if (typeof requestId !== "string" || !requestId) return ""

  return `${sessionId || "root"}:${requestId}`
}
