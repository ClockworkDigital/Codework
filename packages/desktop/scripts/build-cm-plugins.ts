import { cp, mkdir, rm } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))

for (const plugin of [
  { name: "provider", entry: "../cm-provider/src/index.ts" },
  { name: "figma", entry: "../plugins/figma/index.ts" },
  { name: "browser", entry: "../cm-browser/src/plugin.ts" },
]) {
  const destination = `${root}resources/cm-plugins/${plugin.name}`
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })

  const result = await Bun.build({
    entrypoints: [`${root}${plugin.entry}`],
    outdir: destination,
    naming: "index.mjs",
    target: "bun",
    format: "esm",
    external: ["@opencode/plugin", "effect", "effect/*"],
  })

  await Bun.write(
    `${destination}/package.json`,
    JSON.stringify({
      name: `@cookiemonster/desktop-${plugin.name}`,
      type: "module",
      exports: { ".": "./index.mjs", "./server": "./index.mjs" },
    }),
  )

  if (!result.success) throw new AggregateError(result.logs, `Could not build ${plugin.name}`)
}

await cp(`${root}../plugins/figma/skills`, `${root}resources/cm-plugins/figma/skills`, { recursive: true })

await cp(`${root}../plugins/figma/skills-source.json`, `${root}resources/cm-plugins/figma/skills-source.json`)
