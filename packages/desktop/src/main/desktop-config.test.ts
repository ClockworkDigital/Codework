import { expect, test } from "bun:test"
import { desktopConfigContent } from "./desktop-config"

test("desktop defaults retire the relay and leave normal providers available", () => {
  const config = JSON.parse(desktopConfigContent())
  expect(config.disabled_providers).toEqual(["cookiemonster", "wpp", "o1-code"])
  expect(config.provider).toBeUndefined()
  expect(config.model).toBeUndefined()
  expect(config.mcp).toBeUndefined()
  expect(config.disabled_providers).not.toContain("opencode")
  expect(config.disabled_providers).not.toContain("anthropic")
})

test("desktop browser tools compose without requiring a model relay", () => {
  const config = JSON.parse(desktopConfigContent("file:///codework/browser/plugin.mjs"))
  expect(config.plugin).toEqual(["file:///codework/browser/plugin.mjs"])
  expect(config.permission.browser_read_state).toBe("allow")
  expect(config.permission.browser_open_history).toBe("ask")
  expect(config.lsp).toBe(true)
})
