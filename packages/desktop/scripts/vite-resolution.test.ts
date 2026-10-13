import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfigFromFile } from "electron-vite"
import { createServer, normalizePath } from "vite"

test("desktop renderer keeps app contexts in its checkout with shared worktree dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cm-vite-resolution-"))
  const desktop = fileURLToPath(new URL("../", import.meta.url))
  const app = fileURLToPath(new URL("../../app/src/", import.meta.url))
  const config = await loadConfigFromFile(
    { command: "serve", mode: "development" },
    join(desktop, "electron.vite.config.ts"),
    desktop,
  )
  // Reproduce a shared dependency tree pointing at a different checkout without changing real node_modules.
  await Bun.write(
    join(directory, "foreign-app/package.json"),
    JSON.stringify({ name: "@opencode-ai/app", exports: { ".": "./src/index.ts", "./updater": "./src/updater.ts" } }),
  )
  await Bun.write(join(directory, "foreign-app/src/index.ts"), 'export { PlatformProvider } from "./context/platform"')
  await Bun.write(join(directory, "foreign-app/src/context/platform.tsx"), "export const PlatformProvider = {}")
  await Bun.write(join(directory, "foreign-app/src/updater.ts"), "export const updater = {}")
  await mkdir(join(directory, "node_modules/@opencode-ai"), { recursive: true })
  await symlink(
    join(directory, "foreign-app"),
    join(directory, "node_modules/@opencode-ai/app"),
    process.platform === "win32" ? "junction" : "dir",
  )
  await symlink(
    fileURLToPath(new URL("../../ui/", import.meta.url)),
    join(directory, "node_modules/@opencode-ai/ui"),
    process.platform === "win32" ? "junction" : "dir",
  )
  await symlink(
    join(desktop, "node_modules/solid-js"),
    join(directory, "node_modules/solid-js"),
    process.platform === "win32" ? "junction" : "dir",
  )
  const server = await createServer({
    ...config.config.renderer,
    root: directory,
    configFile: false,
    publicDir: false,
    logLevel: "silent",
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  try {
    const entry = await server.pluginContainer.resolveId("@opencode-ai/app", join(directory, "renderer.tsx"))
    expect(entry?.id).toBe(normalizePath(join(app, "index.ts")))
    const provider = await server.pluginContainer.resolveId("./context/platform", entry!.id)
    const consumer = await server.pluginContainer.resolveId("@/context/platform", normalizePath(join(app, "app.tsx")))
    expect(provider?.id).toBe(consumer?.id)
    expect(
      (await server.pluginContainer.resolveId("@opencode-ai/app/updater", join(directory, "renderer.tsx")))?.id,
    ).toBe(normalizePath(join(app, "updater.ts")))
    await Promise.all(
      ["@opencode-ai/ui/theme/context", "@opencode-ai/ui/loading", "solid-js/web"].map(async (id) => {
        const resolved = await server.pluginContainer.resolveId(
          id,
          normalizePath(join(desktop, "src/renderer/index.tsx")),
        )
        expect(resolved).not.toBeNull()
        expect(resolved?.id).toBe((await server.pluginContainer.resolveId(id, normalizePath(join(app, "app.tsx"))))?.id)
      }),
    )
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
