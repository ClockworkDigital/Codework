import { $ } from "bun"
import { join } from "node:path"

const directory = join(import.meta.dir, "../wpp")
const manifest = await Bun.file(join(directory, "package.json")).json()
const source: string = manifest.dependencies["@cookiemonster/wpp"]
const revision = source.slice(source.lastIndexOf("#") + 1)
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("The WPP dependency must pin an immutable Git commit")

// Bun may reuse a Git clone created before a newer commit existed.
await $`bun install --cwd ${directory} --cache-dir ${join(directory, "node_modules/.cache", revision)} ${process.argv.slice(2)}`
