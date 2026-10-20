import { test } from "bun:test"

if (process.env.CM_WPP === "1") {
  await import("./provider.fixture")
  await import("./host-boundaries.fixture.mjs")
  await import("./responses.fixture.mjs")
  await import("./legacy-config.fixture")
}

if (process.env.CM_WPP !== "1") test.skip("WPP contracts require the optional integration and CM_WPP=1", () => {})
