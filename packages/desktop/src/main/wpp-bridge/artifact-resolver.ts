// Persist WPP generated-media artifacts to disk. The bytes live behind a presigned S3 GET (see
// artifact-capture.ts) that is self-authenticating — reqid=1008 confirmed a plain GET with no
// cookie/authorization header returns image/png bytes and access-control-allow-origin:*. So the
// main process can fetch the URL directly; it must do so promptly because the presign expires (~24h).
//
// Dependencies (fetch + fs) are injected so this unit-tests without network or globalThis stubs.

import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { createHash } from "node:crypto"
import type { WppArtifact } from "./artifact-capture"

export type PersistedArtifact = {
  url: string
  kind: WppArtifact["kind"]
  path: string
  bytes: number
  mime: string
  data: string
}

export type ResolveDeps = {
  fetch?: typeof globalThis.fetch
  writeFile?: (path: string, data: Uint8Array) => Promise<void>
  mkdir?: (path: string) => Promise<void>
  signal?: AbortSignal
}

// Files land under this subdir of the resolved target directory so a generation never scatters
// loose media into the project root.
export const ARTIFACT_SUBDIR = "wpp-artifacts"

// Resolve where artifacts are written. Precedence:
//  1. O1_CODE_ARTIFACT_DIR (absolute) — explicit operator override, used verbatim.
//  2. <directory>/wpp-artifacts — when OpenCode conveyed the per-request project directory.
//  3. <cwd>/wpp-artifacts — last-resort fallback (the bridge's own process dir).
// The bridge serves many OpenCode projects from one process, so a project dir must arrive per
// request (see openaiCompat/header threading); there is no single ambient project cwd to assume.
export function artifactTargetDir(directory: string | null | undefined, env = process.env): string {
  const override = env.O1_CODE_ARTIFACT_DIR

  if (override && isAbsolute(override)) return override
  const base = directory && isAbsolute(directory) ? directory : process.cwd()

  return join(base, ARTIFACT_SUBDIR)
}

// Fetch + persist every artifact, returning the ones that landed. Best-effort per item: a single
// failed fetch/write is skipped (logged by the caller via the returned gaps) rather than aborting
// the batch, so one expired presign can't sink an otherwise-good turn. Never throws for HTTP/IO;
// only truly unexpected programmer errors propagate.
export async function persistArtifacts(
  artifacts: WppArtifact[],
  targetDir: string,
  deps: ResolveDeps = {},
): Promise<PersistedArtifact[]> {
  if (artifacts.length === 0) return []

  const doFetch: typeof fetch = (url, options) =>
    (deps.fetch ?? fetch)(url, {
      ...options,
      redirect: "error",
      signal: deps.signal ? AbortSignal.any([deps.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    })
  const writeFile = deps.writeFile ?? ((path, data) => fsWriteFile(path, data))
  const mkdir = deps.mkdir ?? (async (path) => void (await fsMkdir(path, { recursive: true })))

  await mkdir(targetDir)

  const persisted = await Promise.all(artifacts.map((artifact) => persistOne(artifact, targetDir, doFetch, writeFile)))

  return persisted.filter((item): item is PersistedArtifact => item !== null)
}

async function persistOne(
  artifact: WppArtifact,
  targetDir: string,
  doFetch: typeof globalThis.fetch,
  writeFile: (path: string, data: Uint8Array) => Promise<void>,
): Promise<PersistedArtifact | null> {
  const response = await doFetch(artifact.url).catch(() => null)

  if (!response || !response.ok) return null

  const bytes = new Uint8Array(await response.arrayBuffer().catch(() => new ArrayBuffer(0)))

  if (bytes.byteLength === 0) return null

  // WPP's GPT Image outputs reuse names such as 0.png across distinct resource jobs.
  const path = join(
    targetDir,
    `${createHash("sha256").update(new URL(artifact.url).pathname).digest("hex").slice(0, 12)}-${artifact.fileName}`,
  )
  if (
    !(await writeFile(path, bytes).then(
      () => true,
      () => false,
    ))
  )
    return null

  const mime = `image/${artifact.extension === "jpg" ? "jpeg" : artifact.extension}`
  return {
    url: artifact.url,
    kind: artifact.kind,
    path,
    bytes: bytes.byteLength,
    mime,
    data: Buffer.from(bytes).toString("base64"),
  }
}
