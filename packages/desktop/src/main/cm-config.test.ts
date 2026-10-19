import { expect, test } from "bun:test"
import { cookieMonsterConfig } from "./cm-config"

for (const model of [undefined, "cookiemonster/CM_GPT6.1_Sol"]) {
  test(`CookieMonster ${model ? "WPP" : "generic"} config preserves user choices`, () => {
    expect(JSON.parse(cookieMonsterConfig(["cm", "figma"], undefined, model))).toEqual({
      ...(model ? { model } : {}),
      plugins: ["-opencode.browser", "cm", "figma"],
    })
    expect(
      JSON.parse(
        cookieMonsterConfig(["cm", "figma"], '{"model":"custom/model","plugins":["existing","figma"]}', model),
      ),
    ).toEqual({
      model: "custom/model",
      plugins: ["existing", "figma", "-opencode.browser", "cm"],
    })
  })
}

test("CookieMonster rejects malformed user config", () => {
  for (const input of ["null", "[]", '{"plugins":false}', "invalid"]) {
    expect(() => cookieMonsterConfig(["cm"], input)).toThrow()
  }
})
