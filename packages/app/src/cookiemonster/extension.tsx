import { Extension, Command, MenuItem, Panel, type PanelTab, type Setup } from "@opencode/gui-extensions/sdk"
import { createEffect, lazy, onCleanup, Suspense } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { usePlatform } from "@/runtime/platform/platform"
import type { BrowserTabs, DesktopPanelRequest } from "@cookiemonster/cm-browser/panel"
import { showToast } from "@/shell/notifications/toast"

const BrowserPanel = lazy(async () => {
  const { BrowserPanel } = await import("./browser/browser-panel")
  return { default: BrowserPanel }
})

const definition = Extension.define({
  id: "cookiemonster",
  i18n: { en: { browser: "CM Browser", open: "Open CM Browser", failed: "CM Browser could not complete the request" } },
})

const setup: Setup<typeof definition> = (ctx) => {
  const platform = usePlatform()
  const browser = platform.browserPanel

  if (!browser) return
  const [state, setState] = createStore<Record<string, BrowserTabs>>({})
  const tabs = new Map<string, PanelTab>()
  const lease = crypto.randomUUID()
  const key = (tabID: string) => `${ctx.id}:${tabID}`
  let pending: DesktopPanelRequest | undefined
  let frame: number | undefined
  const failed = () => {
    if (!ctx.signal.aborted) showToast({ title: ctx.t("failed"), variant: "error" })
  }

  const accept = (value: BrowserTabs) => {
    if (ctx.signal.aborted) return
    setState(value.sessionID, reconcile(value))
    const session = ctx.sessions.current()

    if (!session || session.id !== value.sessionID) return
    value.tabs.forEach((tab) => {
      if (ctx.layout.state(key(tab.id), session) === "closed") ctx.layout.open(key(tab.id), session, { tab: "append" })
    })
  }

  onCleanup(browser.subscribe(accept))
  createEffect(() => {
    const session = ctx.sessions.current()
    let current = true
    onCleanup(() => {
      current = false
    })
    void browser.linkContext?.(session?.server.builtin ? session.id : null, lease).catch(failed)

    if (session?.server.builtin)
      void browser
        .command(session.id, { op: "state" })
        .then((value) => {
          if (current) accept(value)
        })
        .catch(() => {
          if (current) failed()
        })
  })
  onCleanup(() => {
    pending = undefined

    if (frame !== undefined) cancelAnimationFrame(frame)
    void browser.linkContext?.(null, lease).catch(() => {})
  })

  const open = async () => {
    const session = ctx.sessions.current()

    if (!session?.server.builtin) return
    const value = await browser.command(session.id, { op: "new" }).catch(() => {
      failed()
      return undefined
    })
    if (!value) return
    accept(value)

    if (ctx.signal.aborted || ctx.sessions.current()?.key !== session.key || !value.activeID) return
    ctx.layout.open(key(value.activeID), session)
  }

  ctx.add(Command, { id: "browser", title: ctx.t("open"), bind: "mod+shift+b", run: open })
  ctx.add(MenuItem, { menu: "session.panel", id: "browser", title: ctx.t("browser"), icon: "globe", run: open })
  ctx.add(Panel, {
    id: "browser",
    region: "side",
    list: (input) =>
      (state[input.session.id]?.tabs ?? []).map((tab) => {
        const sessionID = input.session.id
        const existing = tabs.get(tab.id)

        if (existing) return existing

        const entry: PanelTab = {
          id: tab.id,
          group: "browser",
          get title() {
            return state[sessionID]?.tabs.find((value) => value.id === tab.id)?.title || ctx.t("browser")
          },
        }

        tabs.set(tab.id, entry)

        return entry
      }),
    render: (props) => (
      <Suspense>
        <BrowserPanel sessionKey={props.session.key} sessionID={props.session.id} />
      </Suspense>
    ),
    focus: (input) => {
      if (!input.restored)
        void browser.command(input.session.id, { op: "select", tabID: input.tab.id }).then(accept).catch(failed)
    },
    close: (input) => {
      void browser.command(input.session.id, { op: "close", tabID: input.tab.id }).then(accept).catch(failed)
    },
  })

  const acknowledge = async () => {
    const request = pending

    if (
      !request ||
      ctx.signal.aborted ||
      Date.now() >= request.deadline ||
      ctx.sessions.current()?.id !== request.sessionID
    )
      return

    if (!(await browser.panelRequestCurrent?.(request.id, request.sessionID))) return

    if (pending !== request || ctx.signal.aborted) return

    const acknowledgement = { id: request.id, sessionID: request.sessionID }

    if (
      await browser.acknowledgePanel?.(
        request.view === "browser"
          ? { ...acknowledgement, view: request.view, tabID: request.tabID }
          : { ...acknowledgement, view: request.view },
      )
    ) {
      pending = undefined

      return
    }

    if (pending === request) frame = requestAnimationFrame(() => void acknowledge().catch(failed))
  }

  const requested = browser.onPanelRequest?.((request) => {
    const session = ctx.sessions.current()

    if (!session || session.id !== request.sessionID || !session.server.builtin) return
    pending = request

    if (request.view === "browser") ctx.layout.open(key(request.tabID), session)

    if (request.view === "review") ctx.layout.open("review:main", session)

    if (request.view === "hidden" && ctx.layout.side.opened(session)) ctx.layout.side.toggle(session)

    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => void acknowledge().catch(failed))
  })

  if (requested) onCleanup(requested)
  const cancelled = browser.onPanelCancel?.((id) => {
    if (pending?.id === id) pending = undefined
  })

  if (cancelled) onCleanup(cancelled)
}

export const cookieMonster = { ...definition, renderer: async () => ({ default: setup }) }
