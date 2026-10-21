import { describe, expect, test } from "bun:test"
import { consoleReturnWindow, wppLoginOrigin } from "./deep-link"

describe("Console return deep links", () => {
  test("reads the originating Desktop window", () => {
    expect(consoleReturnWindow("opencode://console/authorized?window=window-a")).toBe("window-a")
    expect(consoleReturnWindow("opencode://console/authorized?window=window%20b")).toBe("window b")
  })

  test("rejects unrelated and malformed links", () => {
    expect(consoleReturnWindow("opencode://console/other?window=window-a")).toBeUndefined()
    expect(consoleReturnWindow("opencode://other/authorized?window=window-a")).toBeUndefined()
    expect(consoleReturnWindow("https://console/authorized?window=window-a")).toBeUndefined()
    expect(consoleReturnWindow("not a url")).toBeUndefined()
    expect(consoleReturnWindow("opencode://console/authorized")).toBeUndefined()
  })
})

test("WPP sign-in handoff carries only one bounded origin and no commands or secrets", () => {
  expect(wppLoginOrigin("cookiemonster://wpp/login?origin=http%3A%2F%2F127.0.0.1%3A18787")).toBe(
    "http://127.0.0.1:18787",
  )

  for (const url of [
    "https://wpp/login?origin=http://127.0.0.1:8787",
    "cookiemonster://wpp/other?origin=http://127.0.0.1:8787",
    "cookiemonster://wpp/login",
    "cookiemonster://wpp/login?origin=a&origin=b",
    "cookiemonster://wpp/login?origin=a&command=execute",
    "cookiemonster://wpp/login?origin=a#fragment",
    "cookiemonster://user@wpp/login?origin=a",
  ])
    expect(wppLoginOrigin(url)).toBeUndefined()
})
