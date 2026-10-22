import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import childProcess from "node:child_process"
import { join } from "node:path"
import { BrowserWindow } from "electron"
import { createVaultAccess } from "./vault-access"

if (process.env.CM_LOGIN_ENTRY_TEST_CHILD !== "1") {
  test("native account entry cancels and clears late secret responses", () => {
    const result = Bun.spawnSync([process.execPath, "test", import.meta.path], {
      cwd: join(import.meta.dir, "../../.."),
      env: { ...process.env, CM_LOGIN_ENTRY_TEST_CHILD: "1" },
      timeout: 15_000,
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.exitCode, Buffer.concat([result.stdout, result.stderr]).toString()).toBe(0)
  }, 20_000)
} else {
  const access = createVaultAccess(async () => {})
  let child = new childProcess.ChildProcess()
  let finish: (error: NodeJS.ErrnoException | null, stdout: Buffer, stderr: Buffer) => void
  const spawn = mock((_file: string, _args: string[], _options: object, callback: typeof finish) => {
    finish = callback
    return child
  })
  mock.module("node:child_process", () => ({ ...childProcess, execFile: spawn }))
  mock.module("./vault-session", () => ({ vaultAccess: access }))
  mock.module("./native-secret-entry", () => ({
    nativeSecretEntryAvailable: () => true,
    nativeSecretEntryPath: () => "fixture-entry",
    nativeSecretEntryWindow: () => "0",
  }))
  const { decodeLoginEntry, loginEntry } = await import("./login-entry")
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!

  function window() {
    const win = new BrowserWindow()
    Object.defineProperties(win, {
      isVisible: { value: () => true },
      isMinimized: { value: () => false },
    })
    return win
  }
  function response() {
    const username = Buffer.from("fixture@example.test", "utf16le")
    const password = Buffer.from("fixture-secret", "utf16le")
    const lengths = Buffer.alloc(8)
    lengths.writeUInt32LE(username.length)
    lengths.writeUInt32LE(password.length, 4)
    return Buffer.concat([lengths, username, password])
  }
  beforeEach(async () => {
    Object.defineProperty(process, "platform", { value: "darwin" })
    child = new childProcess.ChildProcess()
    spawn.mockClear()
    await access.unlock(window())
  })
  afterEach(() => {
    access.lock()
    mock.restore()
    Object.defineProperty(process, "platform", platform)
  })

  test("decodes bounded native data and rejects truncated or empty responses", () => {
    expect(decodeLoginEntry("https://login.example.test", response())).toEqual({
      origin: "https://login.example.test",
      username: "fixture@example.test",
      password: "fixture-secret",
    })
    expect(() => decodeLoginEntry("https://login.example.test", response().subarray(0, 10))).toThrow()
    expect(() => decodeLoginEntry("https://login.example.test", Buffer.alloc(8))).toThrow()
  })
  test("an already-aborted signal prevents the native helper from starting", async () => {
    await expect(
      loginEntry.prompt(window(), "https://login.example.test", "", "fixture detail", AbortSignal.abort()),
    ).rejects.toThrow("Account entry cancelled")
    expect(spawn).not.toHaveBeenCalled()
  })
  test("aborting kills the helper and rejects even a late successful secret response", async () => {
    const kill = spyOn(child, "kill").mockReturnValue(true)
    const signal = new AbortController()
    const pending = loginEntry.prompt(window(), "https://login.example.test", "", "fixture detail", signal.signal)
    signal.abort()
    expect(kill).toHaveBeenCalledTimes(1)
    const stdout = response()
    const stderr = Buffer.from("fixture stderr")
    finish(null, stdout, stderr)
    await expect(pending).rejects.toEqual(new Error("Native account entry cancelled or unavailable"))
    expect(stdout.every((byte) => byte === 0)).toBe(true)
    expect(stderr.every((byte) => byte === 0)).toBe(true)
  })
  test("vault locking kills native entry and prevents late disclosure", async () => {
    const kill = spyOn(child, "kill").mockReturnValue(true)
    const pending = loginEntry.prompt(window(), "https://login.example.test", "")
    access.lock()
    expect(kill).toHaveBeenCalledTimes(1)
    const stdout = response()
    finish(null, stdout, Buffer.alloc(0))
    await expect(pending).rejects.toThrow("Native account entry cancelled or unavailable")
    expect(stdout.every((byte) => byte === 0)).toBe(true)
  })
  test("successful native entry resolves a login and clears its binary buffers", async () => {
    const pending = loginEntry.prompt(window(), "https://login.example.test", "")
    const stdout = response()
    finish(null, stdout, Buffer.alloc(0))
    expect(await pending).toEqual({
      origin: "https://login.example.test",
      username: "fixture@example.test",
      password: "fixture-secret",
    })
    expect(stdout.every((byte) => byte === 0)).toBe(true)
  })

  test("Linux saves through a native masked-password form without putting secrets in arguments", async () => {
    Object.defineProperty(process, "platform", { value: "linux" })
    const pending = loginEntry.prompt(window(), "https://login.example.test", "")
    expect(spawn.mock.calls[0][1]).toContain("--forms")
    expect(spawn.mock.calls[0][1].some((arg) => arg.startsWith("--add-password="))).toBe(true)
    const stdout = Buffer.from("fixture@example.test\nfixture-secret\n")
    finish(null, stdout, Buffer.alloc(0))
    expect(await pending).toEqual({
      origin: "https://login.example.test",
      username: "fixture@example.test",
      password: "fixture-secret",
    })
    expect(spawn.mock.calls[0][1].some((arg) => arg.includes("fixture-secret"))).toBe(false)
    expect(stdout.every((byte) => byte === 0)).toBe(true)
    expect(() => decodeLoginEntry("https://login.example.test", Buffer.from("user\nsecret\nextra\n"), true)).toThrow()
    expect(() => decodeLoginEntry("https://login.example.test", Buffer.from("user\n\n"), true)).toThrow()
  })
}
