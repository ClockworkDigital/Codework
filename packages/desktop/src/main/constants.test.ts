import { expect, test } from "bun:test"
import { resolveAppIdentity } from "./constants"

test("uses CookieMonster identity for branded packaged builds", () => {
  expect(resolveAppIdentity("prod", true, true)).toEqual({
    name: "CookieMonster",
    appId: "com.ogilvy.cookiemonster",
  })
})

test("keeps the development identity for unpackaged builds", () => {
  expect(resolveAppIdentity("prod", true, false)).toEqual({
    name: "OpenCode Dev",
    appId: "ai.opencode.desktop.dev",
  })
})

test("keeps upstream packaged channel identities", () => {
  expect(resolveAppIdentity("beta", false, true)).toEqual({
    name: "OpenCode Beta",
    appId: "ai.opencode.desktop.beta",
  })
  expect(resolveAppIdentity("prod", false, true)).toEqual({
    name: "OpenCode",
    appId: "ai.opencode.desktop",
  })
})
