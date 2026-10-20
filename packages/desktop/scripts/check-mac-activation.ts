import { join } from "node:path"
import { Schema } from "effect"

if (process.platform !== "darwin") throw new Error("Packaged activation must be checked on macOS.")

const bundle = process.argv[2]

if (!bundle?.endsWith("/CookieMonster.app")) throw new Error("Pass the owned packaged CookieMonster.app path.")

const executable = Bun.spawnSync([
  "/usr/libexec/PlistBuddy",
  "-c",
  "Print :CFBundleExecutable",
  join(bundle, "Contents/Info.plist"),
])

if (executable.exitCode !== 0) throw new Error("Could not read the packaged executable.")

const child = Bun.spawn(
  [join(bundle, "Contents/MacOS", executable.stdout.toString().trim()), "--inspect=127.0.0.1:9347"],
  { stdout: "inherit", stderr: "inherit" },
)

const Evaluation = Schema.Struct({
  result: Schema.Struct({ value: Schema.optionalKey(Schema.Boolean) }),
  exceptionDetails: Schema.optionalKey(
    Schema.Struct({
      text: Schema.String,
      exception: Schema.optionalKey(Schema.Struct({ description: Schema.optionalKey(Schema.String) })),
    }),
  ),
})

const waiting = new Map<number, { resolve: (value: typeof Evaluation.Type) => void; reject: (error: Error) => void }>()

const Reply = Schema.Struct({
  id: Schema.optionalKey(Schema.Number),
  result: Schema.optionalKey(Evaluation),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
})

const Targets = Schema.Array(Schema.Struct({ type: Schema.String, webSocketDebuggerUrl: Schema.String }))

let socket: WebSocket | undefined

let sequence = 0

try {
  const deadline = Date.now() + 30_000

  while (!socket && Date.now() < deadline) {
    const response = await fetch("http://127.0.0.1:9347/json/list", { signal: AbortSignal.timeout(500) }).catch(
      () => undefined,
    )

    if (response?.ok) {
      const target = Schema.decodeUnknownSync(Targets)(await response.json()).find((target) => target.type === "node")

      if (target) socket = new WebSocket(target.webSocketDebuggerUrl)
    }

    if (!socket) await Bun.sleep(100)
  }

  const connection = socket

  if (!connection) throw new Error("The owned packaged app did not open its inspector.")
  await new Promise<void>((resolve, reject) => {
    connection.addEventListener("open", () => resolve(), { once: true })
    connection.addEventListener("error", () => reject(new Error("Packaged inspector connection failed.")), {
      once: true,
    })
  })
  connection.addEventListener("message", (event) => {
    const reply = Schema.decodeUnknownSync(Reply)(JSON.parse(String(event.data)))

    if (reply.id === undefined) return
    const request = waiting.get(reply.id)
    waiting.delete(reply.id)

    if (reply.error) request?.reject(new Error(reply.error.message))
    else if (reply.result) request?.resolve(reply.result)
  })

  const evaluate = async (expression: string) => {
    const id = ++sequence

    const result = await new Promise<typeof Evaluation.Type>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error("Packaged inspector request timed out."))
      }, 5000)

      waiting.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      // Inspector interrupts can reenter Node's module loader before its initialization finishes.
      connection.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: {
            expression: `new Promise(resolve => process.nextTick(() => setImmediate(resolve))).then(() => (${expression}))`,
            returnByValue: true,
            awaitPromise: true,
          },
        }),
      )
    })

    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)

    if (result.result.value === undefined) throw new Error("Packaged activation did not return a boolean.")

    return result.result.value
  }

  if (!(await evaluate(`process.pid === ${child.pid}`)))
    throw new Error("Inspector belongs to another process; refusing to operate it.")
  const native = `process.getBuiltinModule('module').createRequire(process.execPath)('electron')`
  const usable = `Boolean(${native}.BrowserWindow?.getAllWindows().some(w => w !== globalThis.__cmActivationWorker && w.isVisible() && w.webContents.getURL().startsWith('oc://renderer/')))`

  const waitFor = async (stage: string, expression: string) => {
    console.log(`Checking packaged activation: ${stage}`)
    const deadline = Date.now() + 30_000

    while (Date.now() < deadline) {
      if (await evaluate(expression)) return
      await Bun.sleep(100)
    }

    await evaluate(`(() => {
      const {app, BrowserWindow} = ${native};
      console.log(JSON.stringify({
        stage: ${JSON.stringify(stage)},
        ready: app?.isReady(),
        activationHandlers: app?.listenerCount('activate'),
        activationEvents: globalThis.__cmActivationEvents ?? 0,
        windows: BrowserWindow?.getAllWindows().map(window => {
          const url = URL.parse(window.webContents.getURL());
          return {
            id: window.id,
            visible: window.isVisible(),
            minimized: window.isMinimized(),
            loading: window.webContents.isLoading(),
            page: url ? url.protocol + '//' + url.host + url.pathname : '',
            worker: window === globalThis.__cmActivationWorker,
          };
        }),
      }));
      return true;
    })()`)
    throw new Error(`Packaged activation condition timed out: ${stage}`)
  }

  // The inspector can precede BrowserWindow exports; the early window also needs lifecycle adoption before close.
  await waitFor(
    "initial main window and lifecycle adoption",
    `${usable} && ${native}.app.listenerCount('activate') > 0`,
  )

  if (!(await evaluate(`${native}.app.isPackaged`))) throw new Error("This must exercise a packaged application.")
  await evaluate(`(() => {
    const {app, BrowserWindow} = ${native};
    globalThis.__cmActivationEvents = 0;
    app.on('activate', () => globalThis.__cmActivationEvents++);
    globalThis.__cmActivationWorker = new BrowserWindow({show:false, webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    BrowserWindow.getAllWindows().filter(w => w !== globalThis.__cmActivationWorker).forEach(w => w.close());
    app.hide();
    return true;
  })()`)
  await waitFor(
    "main windows closed with hidden worker preserved",
    `${native}.BrowserWindow.getAllWindows().length === 1 && !globalThis.__cmActivationWorker.isDestroyed()`,
  )

  const activation = Bun.spawn(["/usr/bin/osascript", "-e", `tell application ${JSON.stringify(bundle)} to activate`], {
    stdout: "inherit",
    stderr: "inherit",
  })

  const activationTimer = setTimeout(() => activation.kill("SIGTERM"), 15_000)
  const activationCode = await activation.exited
  clearTimeout(activationTimer)

  if (activationCode !== 0) throw new Error("macOS could not activate the owned packaged app.")
  await waitFor(
    "native activation and restored visible main window",
    `globalThis.__cmActivationEvents > 0 && ${usable}`,
  )

  if (!(await evaluate(`!globalThis.__cmActivationWorker.isDestroyed()`)))
    throw new Error("Activation destroyed the hidden worker.")
  console.log(
    JSON.stringify({
      result: "pass",
      packaged: true,
      platform: "darwin",
      nativeActivation: true,
      mainWindowRestored: true,
      hiddenWorkerPreserved: true,
    }),
  )
} finally {
  socket?.close()

  if (child.exitCode === null) {
    child.kill("SIGTERM")
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000)
    await child.exited
    clearTimeout(timer)
  }
}
