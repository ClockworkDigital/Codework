// SAFETY: This fixture owns its synthetic native objects, runtime probes and malformed inputs; partial shapes deliberately exercise the production guards.
/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion */
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { artifactTargetDir, persistArtifacts } from "./artifact-resolver"
import type { WppArtifact } from "./artifact-capture"

const IMAGE: WppArtifact = {
  url: "https://wpp-ai-base-prd-persistentdatabucket.s3.eu-west-1.amazonaws.com/resource/x/y/pic.png?X-Amz-Signature=abc",
  kind: "image",
  fileName: "pic.png",
  extension: "png",
}

function fakeResponse(bytes: Uint8Array, ok = true): Response {
  return {
    ok,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response
}

describe("artifactTargetDir", () => {
  test("prefers an absolute O1_CODE_ARTIFACT_DIR override", () => {
    const dir = artifactTargetDir("/some/project", { O1_CODE_ARTIFACT_DIR: "/tmp/arts" } as NodeJS.ProcessEnv)
    expect(dir).toBe("/tmp/arts")
  })

  test("ignores a relative override and uses the project directory", () => {
    const dir = artifactTargetDir("/some/project", { O1_CODE_ARTIFACT_DIR: "relative/nope" } as NodeJS.ProcessEnv)
    expect(dir).toBe(join("/some/project", "wpp-artifacts"))
  })

  test("uses <directory>/wpp-artifacts when a project directory is given", () => {
    expect(artifactTargetDir("/home/me/proj", {} as NodeJS.ProcessEnv)).toBe(join("/home/me/proj", "wpp-artifacts"))
  })

  test("falls back to cwd/wpp-artifacts when no directory and no override", () => {
    expect(artifactTargetDir(null, {} as NodeJS.ProcessEnv)).toBe(join(process.cwd(), "wpp-artifacts"))
    expect(artifactTargetDir(undefined, {} as NodeJS.ProcessEnv)).toBe(join(process.cwd(), "wpp-artifacts"))
  })
})

describe("persistArtifacts", () => {
  test("skips a disk write failure and forwards cancellation to the signed download", async () => {
    const signal = new AbortController().signal
    const result = await persistArtifacts([IMAGE], "/target", {
      signal,
      fetch: async (_url, options) => {
        expect(options?.signal).toBeDefined()
        expect(options?.redirect).toBe("error")
        return fakeResponse(new Uint8Array([1]))
      },
      mkdir: async () => {},
      writeFile: async () => {
        throw new Error("disk full")
      },
    })
    expect(result).toEqual([])
  })
  test("returns [] for an empty batch without touching fs", async () => {
    let mkdirCalls = 0
    const result = await persistArtifacts([], "/target", { mkdir: async () => void (mkdirCalls += 1) })
    expect(result).toEqual([])
    expect(mkdirCalls).toBe(0)
  })

  test("fetches the presigned URL and writes bytes under the target dir", async () => {
    const writes: Array<{ path: string; bytes: number }> = []
    const fetched: string[] = []

    const result = await persistArtifacts([IMAGE], "/target", {
      fetch: (async (url: string) => {
        fetched.push(String(url))

        return fakeResponse(new Uint8Array([1, 2, 3, 4]))
      }) as unknown as typeof fetch,
      writeFile: async (path, data) => void writes.push({ path, bytes: data.byteLength }),
      mkdir: async () => {},
    })

    expect(fetched).toEqual([IMAGE.url])
    expect(writes).toEqual([{ path: join("/target", "0a7182e61934-pic.png"), bytes: 4 }])
    expect(result).toEqual([
      {
        url: IMAGE.url,
        kind: "image",
        path: join("/target", "0a7182e61934-pic.png"),
        bytes: 4,
        mime: "image/png",
        data: "AQIDBA==",
      },
    ])
  })

  test("keeps separate resource jobs that both name their output 0.png", async () => {
    const writes: string[] = []
    const result = await persistArtifacts(
      ["first", "second"].map((job) => ({
        ...IMAGE,
        url: IMAGE.url.replace("/x/y/pic.png", `/${job}/0.png`),
        fileName: "0.png",
      })),
      "/target",
      {
        fetch: async () => fakeResponse(new Uint8Array([1])),
        mkdir: async () => {},
        writeFile: async (path) => {
          writes.push(path)
        },
      },
    )
    expect(result).toHaveLength(2)
    expect(new Set(writes).size).toBe(2)
  })

  test("skips an item whose fetch rejects, keeping the rest (best-effort)", async () => {
    const good: WppArtifact = { ...IMAGE, url: IMAGE.url.replace("pic", "good"), fileName: "good.png" }
    const bad: WppArtifact = { ...IMAGE, url: IMAGE.url.replace("pic", "bad"), fileName: "bad.png" }

    const result = await persistArtifacts([bad, good], "/target", {
      fetch: (async (url: string) => {
        if (String(url).includes("bad")) throw new Error("network down")

        return fakeResponse(new Uint8Array([9]))
      }) as unknown as typeof fetch,
      writeFile: async () => {},
      mkdir: async () => {},
    })

    expect(result).toHaveLength(1)
    expect(result[0].path.endsWith("-good.png")).toBe(true)
  })

  test("skips a non-ok HTTP response", async () => {
    const result = await persistArtifacts([IMAGE], "/target", {
      fetch: (async () => fakeResponse(new Uint8Array([1]), false)) as unknown as typeof fetch,
      writeFile: async () => {},
      mkdir: async () => {},
    })

    expect(result).toEqual([])
  })

  test("skips an empty (zero-byte) body", async () => {
    let wrote = false

    const result = await persistArtifacts([IMAGE], "/target", {
      fetch: (async () => fakeResponse(new Uint8Array([]))) as unknown as typeof fetch,
      writeFile: async () => void (wrote = true),
      mkdir: async () => {},
    })

    expect(result).toEqual([])
    expect(wrote).toBe(false)
  })
})
