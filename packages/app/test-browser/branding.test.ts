import { expect, test } from "bun:test"
import { build } from "vite"
import appPlugin from "../vite.js"

for (const wpp of [false, true]) {
  test(`CookieMonster WPP=${wpp} chooses the matching logo assets`, async () => {
    const previous = process.env.CM_WPP
    try {
      process.env.CM_WPP = wpp ? "1" : "0"
      const output = await build({
        configFile: false,
        logLevel: "error",
        plugins: [appPlugin],
        build: {
          write: false,
          minify: false,
          assetsInlineLimit: 0,
          rolldownOptions: { input: "src/assets/cookie-monster-banner.ts", preserveEntrySignatures: "strict" },
        },
      })
      const code = [output]
        .flat()
        .flatMap((result) => ("output" in result ? result.output : []))
        .flatMap((chunk) => (chunk.type === "chunk" ? [chunk.code] : []))
        .join("\n")
      const logos = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)
      expect(logos.cookieMonsterBannerLight).toContain(`cookie-monster-banner-${wpp ? "" : "generic-"}light-`)
      expect(logos.cookieMonsterBannerDark).toContain(`cookie-monster-banner-${wpp ? "" : "generic-"}dark-`)
    } finally {
      if (previous === undefined) delete process.env.CM_WPP
      if (previous !== undefined) process.env.CM_WPP = previous
    }
  })
}
