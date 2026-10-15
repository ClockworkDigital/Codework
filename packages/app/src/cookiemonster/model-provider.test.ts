import { expect, test } from "bun:test"
import { cookieMonsterModelProvider } from "./model-provider"

test.each([
  ["cookiemonster", "claude", "anthropic"],
  ["cookiemonster", "claude-sonnet", "anthropic"],
  ["cookiemonster", "gpt", "openai"],
  ["cookiemonster", "gpt-5", "openai"],
  ["cookiemonster", "gemini", "google"],
  ["cookiemonster", "unknown", undefined],
  ["cookiemonster", undefined, undefined],
  ["custom", "claude", undefined],
] as const)("resolves the model maker for %s / %s", (provider, family, expected) => {
  expect(cookieMonsterModelProvider(provider, family)).toBe(expected)
})
