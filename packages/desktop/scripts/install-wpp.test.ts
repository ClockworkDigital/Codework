import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("WPP installation rejects a mutable ref before invoking Git", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cm-wpp-install-"))
  try {
    const script = join(directory, "scripts/install-wpp.ts")
    await Bun.write(script, await Bun.file(new URL("./install-wpp.ts", import.meta.url)).text())
    await Bun.write(
      join(directory, "wpp/package.json"),
      JSON.stringify({
        dependencies: { "@cookiemonster/wpp": "git+ssh://git@github.com/trmosala/CM-WPP-Bits.git#v2-split" },
      }),
    )
    const child = Bun.spawn([process.execPath, script], {
      env: { ...process.env, GIT_SSH_COMMAND: "false", GIT_TERMINAL_PROMPT: "0" },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await child.exited).not.toBe(0)
    expect(await new Response(child.stderr).text()).toContain("must pin an immutable Git commit")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
