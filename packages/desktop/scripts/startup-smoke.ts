import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import electron from "electron"

// Run after building, or pass an extracted packaged app directory as the first argument.
// Stall the real Electron logging API to verify startup still presents the main window.
const directory = await mkdtemp(join(tmpdir(), "cm-startup-smoke-"))
const target = resolve(process.argv[2] ?? ".")
try {
  const entry = join(directory, "startup.cjs")
  await Bun.write(
    entry,
    `const { app, netLog, BrowserWindow } = require("electron")
process.env.OPENCODE_TEST_ONBOARDING = "1"
netLog.startLogging = () => new Promise(() => {})
app.setAppPath(${JSON.stringify(target)})
const errors = []
app.on("web-contents-created", (_, contents) => {
  contents.on("console-message", (event) => {
    if (event.message.includes("context must be used within a context provider")) errors.push(event.message)
  })
  contents.on("render-process-gone", (_, details) => errors.push("renderer exited: " + details.reason))
})
const timer = setTimeout(async () => {
  const windows = BrowserWindow.getAllWindows().filter(win => win.webContents.getURL().startsWith("oc://renderer/"))
  const states = await Promise.all(windows.map(async win => ({
    visible: win.isVisible(),
    rendered: await win.webContents.executeJavaScript(
      ${JSON.stringify("Array.from(document.querySelectorAll('[data-component=\"prompt-input\"]')).some(element => element.isContentEditable && element.getClientRects().length > 0)")}
    ).catch(error => { errors.push(String(error)); return false }),
  })))
  const ready = states.some(state => state.visible && state.rendered)
  console.log("STARTUP_CHECK " + JSON.stringify({ windows: windows.length, ready, errors }))
  app.exit(ready && errors.length === 0 ? 0 : 1)
}, 15000)
app.on("will-quit", () => clearTimeout(timer))
import(${JSON.stringify(pathToFileURL(join(target, "out/main/index.js")).href)})
`,
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = Bun.spawn([electron, entry], { env, stdout: "inherit", stderr: "inherit" })
  const timeout = setTimeout(() => {
    console.error("STARTUP_CHECK timed out")
    child.kill()
  }, 30_000)
  try {
    process.exitCode = await child.exited
  } finally {
    clearTimeout(timeout)
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}
