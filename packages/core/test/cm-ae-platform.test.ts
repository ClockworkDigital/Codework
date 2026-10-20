import { expect, test } from "bun:test"
import { join } from "node:path"
import { CmAePlugin } from "#cm-ae-plugin"

test("native AE registration keeps the desktop plugin", () => {
  expect(CmAePlugin.plugins).toHaveLength(1)
  expect(CmAePlugin.plugins[0] === CmAePlugin.Plugin).toBe(true)
})

test("workerd omits the native AE bundle loader", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--conditions=workerd",
      "-e",
      'import { CmAePlugin } from "#cm-ae-plugin"; console.log(CmAePlugin.plugins.length)',
    ],
    { cwd: join(import.meta.dir, "..") },
  )
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(result.stdout.toString().trim()).toBe("0")
})
