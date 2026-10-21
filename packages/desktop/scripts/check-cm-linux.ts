import assert from "node:assert/strict"
import { $ } from "bun"

const artifact = process.argv[2]

assert(artifact?.endsWith(".deb"), "Pass a CookieMonster Debian archive")

const id = "com.ogilvy.cookiemonster"

const entries = (await $`dpkg-deb --fsys-tarfile ${artifact} | tar -tf -`.text())
  .split("\n")
  .map((entry) => entry.replace(/^\.\//, ""))
  .filter(Boolean)

assert.equal((await $`dpkg-deb -f ${artifact} Package`.text()).trim(), "cookiemonster")

assert(entries.includes(`usr/share/applications/${id}.desktop`), "CookieMonster desktop entry is missing")

assert(entries.includes(`usr/share/metainfo/${id}.metainfo.xml`), "CookieMonster metainfo is missing")

assert(entries.includes(`opt/CookieMonster/${id}`), "CookieMonster executable has the wrong name")

assert(
  entries.some((entry) => entry.startsWith("usr/share/icons/") && entry.endsWith(`/${id}.png`)),
  "CookieMonster icons are missing",
)

const collisions = entries.filter(
  (entry) =>
    entry.startsWith("usr/share/applications/ai.opencode.") ||
    entry === "usr/share/applications/opencode-desktop.desktop" ||
    entry.startsWith("usr/share/metainfo/ai.opencode.") ||
    (entry.startsWith("usr/share/icons/") && /\/(?:ai\.opencode\.|opencode-desktop\.)/.test(entry)),
)

assert.deepEqual(collisions, [], "CookieMonster archive contains upstream-owned launcher or icon paths")

const desktop = await $`dpkg-deb --fsys-tarfile ${artifact} | tar -xOf - ./usr/share/applications/${id}.desktop`.text()

assert.match(desktop, new RegExp(`^StartupWMClass=${id.replaceAll(".", "\\.")}$`, "m"))

assert(desktop.includes(`Icon=${id}\n`), "Desktop icon identity differs from its file name")

assert(desktop.includes(`/CookieMonster/${id}`), "Desktop launcher points at the wrong executable")

const metadata =
  await $`dpkg-deb --fsys-tarfile ${artifact} | tar -xOf - ./usr/share/metainfo/${id}.metainfo.xml`.text()

assert(metadata.includes(`<id>${id}</id>`), "Metainfo identity differs from packaging")

assert(
  metadata.includes(`<launchable type="desktop-id">${id}.desktop</launchable>`),
  "Metainfo points at the wrong launcher",
)

console.log(JSON.stringify({ artifact, appId: id, entries: entries.length, result: "pass" }))
