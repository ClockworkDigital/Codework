import { expect, test } from "bun:test"
import { resolveAppIdentity } from "./constants"

test("uses Codework identity for branded packaged builds", () => {
  expect(resolveAppIdentity("prod", true, true)).toEqual({
    name: "Codework",
    appId: "digital.clockwork.codework",
  })
})

test("keeps the development identity for unpackaged builds", () => {
  expect(resolveAppIdentity("prod", true, false)).toEqual({
    name: "Codework Dev",
    appId: "digital.clockwork.codework.dev",
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
