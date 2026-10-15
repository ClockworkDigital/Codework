import { expect, test } from "bun:test"
import { cookieMonsterConfig } from "./cm-config"

test("CookieMonster seeds both native plugins without replacing user choices", () => {
  expect(
    JSON.parse(cookieMonsterConfig(["cm", "figma"], '{"model":"custom/model","plugins":["existing","figma"]}')),
  ).toEqual({
    model: "custom/model",
    plugins: ["existing", "figma", "-opencode.browser", "cm"],
  })

  for (const input of ["null", "[]", '{"plugins":false}', "invalid"]) {
    expect(() => cookieMonsterConfig(["cm"], input)).toThrow()
  }
})
