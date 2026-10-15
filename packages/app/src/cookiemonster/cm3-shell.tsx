import { Schema } from "effect"
import { Persistence } from "@/runtime/persistence/schema"
import { sessionLabel } from "@/session/title"
import { createStore, reconcile } from "solid-js/store"
import { ResizeHandle } from "@opencode/ui/resize-handle"
import { createEffect, createMemo, For, on, onCleanup, Show, type Accessor } from "solid-js"
import { useLocation } from "@solidjs/router"
import { useLanguage } from "@/runtime/i18n/language"
import { ServerConnection } from "@/runtime/server/registry"
import { decode64 } from "@/runtime/persistence/base64"
import { pathKey } from "@/workspaces/path-key"
import { tabKey, useTabs, type DraftTab } from "@/shell/tabs/tabs"
import { createDraftComposerState } from "@/composer/state"
import { type LocalProject } from "@/shell/state/layout"
import { displayName } from "@opencode/ui/project-avatar"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { createHomeController } from "@/home/model"
import { createHomeSessionsController, type HomeSessionRecord } from "@/home/sessions/controller"
import { createHomeProjectsController } from "@/home/projects/controller"
import { CmProjects } from "./cm-projects"
import { shouldOpenSessionInBackground } from "@/home/sessions/open"
import { SessionTabAvatarView } from "@/shell/layout/session-tab-avatar"
import { useSessionTabAvatarState } from "@/shell/layout/project-avatar-state"
import { useDirectoryPicker } from "@/workspaces/selection/picker"
import { useSettingsDialog } from "@/settings/command"
import { Cm3Icon } from "./cm3-icon"
import { WppAuthControl } from "./wpp-auth-control"
import { Icon } from "@opencode/ui/icon"
import { Menu } from "@opencode/ui/menu"
import { useTheme } from "@opencode/ui/theme"
import cookieMonsterBannerLight from "@/assets/cookie-monster-banner-light.svg"
import cookieMonsterBannerDark from "@/assets/cookie-monster-banner-dark.svg"
import { useScheduling } from "./scheduling-panel"
import { useCommand } from "@/shell/commands/command"
import { createMediaQuery } from "@solid-primitives/media"

const PROJECT_SESSIONS_PAGE = 5

type ProjectChat = { key: string; title: string; updated: number } & (
  | { type: "session"; record: HomeSessionRecord }
  | { type: "draft"; tab: DraftTab; project: LocalProject }
)

export function Cm3Shell(props: { onTabsMount: (element: HTMLElement) => void }) {
  const scheduling = useScheduling()
  const command = useCommand()
  const mobile = createMediaQuery("(max-width: 640px)")
  const home = createHomeController()
  const sessions = createHomeSessionsController(home, { registerPalette: false, allProjects: true })
  const language = useLanguage()
  const theme = useTheme()
  const location = useLocation()
  const tabs = useTabs()
  const pickDirectory = useDirectoryPicker()
  const openSettings = useSettingsDialog()
  const projects = createHomeProjectsController(home)
  const [state, setState] = createStore({ search: "", navigation: false })
  const [sessionLimits, setSessionLimits] = createStore<Record<string, number>>({})
  createEffect(
    on(
      () => state.search,
      () => setSessionLimits(reconcile({})),
      { defer: true },
    ),
  )
  const [sidebar, setSidebar] = persisted(
    Persist.global("cm3.sidebar"),
    Persistence.struct({ collapsed: Schema.Boolean, width: Schema.Number }),
    { collapsed: false, width: 260 },
  )
  const refs: { toggle?: HTMLButtonElement; nav?: HTMLElement; search?: HTMLInputElement } = {}
  createEffect(() => {
    refs.nav?.parentElement?.style.setProperty("--cm3-sidebar-width", `${sidebar.collapsed ? 48 : sidebar.width}px`)
  })
  onCleanup(() => {
    refs.nav?.parentElement?.style.removeProperty("--cm3-sidebar-width")
  })

  command.register("cm3-sidebar", () => [
    {
      id: "sidebar.toggle",
      title: language.t("command.sidebar.toggle"),
      category: language.t("command.category.view"),
      onSelect: () => {
        if (mobile()) {
          setState("navigation", (value) => !value)

          return
        }

        setSidebar("collapsed", (value) => !value)
      },
    },
  ])

  const closeNavigation = () => {
    setState("navigation", false)
    refs.toggle?.focus({ preventScroll: true })
  }

  createEffect(on(() => `${location.pathname}${location.search}`, closeNavigation, { defer: true }))

  const routeProject = createMemo(
    () => {
      const path = `${location.pathname}${location.search}`
      const target = location.pathname.match(/^\/server\/([^/]+)\/session\/([^/]+)$/)

      if (target) {
        const key = decode64(target[1])
        const conn = home.server.list().find((item) => ServerConnection.key(item) === key)

        if (!conn) return undefined

        const tab = tabs.store.find(
          (item) => item.type === "session" && item.server === key && item.sessionId === target[2],
        )

        const directory = tab ? tabs.info[tabKey(tab)]?.directory : undefined

        if (!directory) return undefined

        return { path, server: ServerConnection.key(conn), directory }
      }

      if (location.pathname !== "/new-session") return undefined
      const draftID = new URLSearchParams(location.search).get("draftId")
      const draft = tabs.store.find((item) => item.type === "draft" && item.draftID === draftID)

      if (draft?.type === "draft") return { path, server: draft.server, directory: draft.directory }

      return undefined
    },
    undefined,
    {
      // Unrelated tab hydration must not undo a project explicitly selected in the sidebar.
      equals: (previous, next) =>
        previous?.path === next?.path && previous?.server === next?.server && previous?.directory === next?.directory,
    },
  )

  createEffect(
    on(routeProject, (project) => {
      if (!project) return
      home.selection.set({ server: project.server, directory: project.directory })
      const conn = home.server.list().find((item) => ServerConnection.key(item) === project.server)

      if (!conn) return
      const ctx = home.server.context(conn)

      const item = ctx.projects
        .list()
        .find((item) =>
          [item.worktree, ...(item.sandboxes ?? [])].some(
            (directory) => pathKey(directory) === pathKey(project.directory),
          ),
        )

      if (item) ctx.projects.expand(item.worktree)
    }),
  )
  const projectPending = () => /^\/server\/[^/]+\/session\/[^/]+$/.test(location.pathname) && !routeProject()

  const searchRecords = createMemo(() => {
    const value = state.search.trim().toLowerCase()

    return sessions.data
      .searchRecords()
      .filter((record) => `${sessionLabel(record.session)} ${record.projectName}`.toLowerCase().includes(value))
  })

  const pinnedRecords = createMemo(() => searchRecords().filter((record) => sessions.session.isPinned(record.session)))

  const drafts = createMemo(() =>
    tabs.store.filter((tab): tab is DraftTab => tab.type === "draft" && tab.server === sessions.session.server()),
  )

  const draftID = () => location.pathname === "/new-session" && new URLSearchParams(location.search).get("draftId")

  const activeSession = (id: string) =>
    location.pathname.endsWith(`/session/${id}`) && routeProject()?.server === sessions.session.server()

  const chats = createMemo<ProjectChat[]>(() => {
    const value = state.search.trim().toLowerCase()

    return [
      ...searchRecords().map((record) => ({
        type: "session" as const,
        key: record.session.id,
        title: sessionLabel(record.session),
        updated: record.session.time.updated ?? record.session.time.created,
        record,
      })),
      ...drafts().flatMap((tab) => {
        const project = home.project
          .list()
          .find((project) =>
            [project.worktree, ...(project.sandboxes ?? [])].some(
              (directory) => pathKey(directory) === pathKey(tab.directory),
            ),
          )

        if (!project) return []
        const prompt = tabs.state(tab, "prompt", () => createDraftComposerState(tab.draftID))

        const title =
          prompt
            .current()
            .map((part) => ("content" in part ? part.content : ""))
            .join("")
            .split(/\r?\n/)
            .find((line) => line.trim())
            ?.trim()
            .slice(0, 80) || language.t("quietCompanion.newTask")

        if (!`${title} ${displayName(project)}`.toLowerCase().includes(value)) return []

        return [{ type: "draft" as const, key: `draft:${tab.draftID}`, title, updated: 0, tab, project }]
      }),
    ].sort((a, b) => b.updated - a.updated || a.key.localeCompare(b.key))
  })

  const activeChat = (chat: ProjectChat) =>
    chat.type === "draft" ? draftID() === chat.tab.draftID : activeSession(chat.record.session.id)

  const projectSessions = createMemo(() => {
    const grouped = new Map<string, ProjectChat[]>()
    chats().forEach((chat) => {
      const key = pathKey(chat.type === "draft" ? chat.project.worktree : chat.record.project.worktree)
      const group = grouped.get(key)

      if (group) group.push(chat)

      if (!group) grouped.set(key, [chat])
    })

    return grouped
  })

  const openChat = (chat: ProjectChat, background = false) => {
    if (chat.type === "session") return openSession(chat.record, background)

    if (background) return
    closeNavigation()
    tabs.select(chat.tab)
  }

  const openSession = (record: HomeSessionRecord, background = false) => {
    if (!background) closeNavigation()
    sessions.session.open(record.session, { background })
  }

  const backgroundOpen = (event: MouseEvent) =>
    shouldOpenSessionInBackground({
      button: event.button,
      mac: /(Mac|iPod|iPhone|iPad)/.test(navigator.platform),
      meta: event.metaKey,
      ctrl: event.ctrlKey,
      shift: event.shiftKey,
      alt: event.altKey,
    })

  const navigateSearch = (event: KeyboardEvent) => {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return

    if (event.key === "Enter" && event.target === refs.search && state.search.trim()) {
      const chat = chats()[0]

      if (!chat) return
      event.preventDefault()
      openChat(chat)

      return
    }

    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    const controls = Array.from(refs.nav?.querySelectorAll<HTMLButtonElement>(".cm3-sidebar-task") ?? [])

    if (!controls.length) return
    event.preventDefault()
    const index = controls.findIndex((element) => element === event.currentTarget)

    const next =
      index < 0
        ? event.key === "ArrowDown"
          ? 0
          : controls.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + controls.length) % controls.length

    controls[next]?.focus()
  }

  const openTask = (conn: ServerConnection.Any, directory: string) =>
    home.project.openProjectNewSession(conn, directory)

  const create = () => {
    if (projectPending()) return
    const conn = home.server.focused()
    const project = home.project.newSession()

    if (!conn) return
    closeNavigation()

    if (!project) {
      pickDirectory({
        server: conn,
        onSelect: (result) => {
          if (!result) return
          const directories = Array.isArray(result) ? result : [result]
          home.project.add(conn, directories)

          if (directories[0]) openTask(conn, directories[0])
        },
      })

      return
    }

    openTask(conn, project.worktree)
  }

  const renderSession = (record: Accessor<HomeSessionRecord>, recent = false) => {
    const avatar = useSessionTabAvatarState(
      sessions.session.server,
      () => record().session.id,
      () => true,
    )

    const description = () => {
      if (avatar.hasQuestions()) return language.t("sidebar.session.status.question")

      if (avatar.hasPermissions()) return language.t("sidebar.session.status.permission")

      if (avatar.loading()) return language.t("sidebar.session.status.running")

      if (avatar.unread()) return language.t("sidebar.session.status.unread")

      return undefined
    }

    return (
      <div
        class="cm3-sidebar-session"
        data-session-id={record().session.id}
        role="group"
        aria-label={record().session.title}
      >
        <button
          class="cm3-sidebar-task"
          data-action={recent ? "recent-session" : "project-session"}
          type="button"
          data-active={activeSession(record().session.id)}
          aria-current={activeSession(record().session.id) ? "page" : undefined}
          aria-description={description()}
          onKeyDown={navigateSearch}
          onMouseDown={(event) => {
            if (event.button === 1) event.preventDefault()
          }}
          onClick={(event) => openSession(record(), backgroundOpen(event))}
          onAuxClick={(event) => {
            if (!backgroundOpen(event)) return
            event.preventDefault()
            openSession(record(), true)
          }}
        >
          <div class="size-4 shrink-0" aria-hidden="true">
            <SessionTabAvatarView
              sessionID={record().session.id}
              project={record().project}
              directory={record().session.location.directory}
              unread={avatar.unread()}
              loading={avatar.loading()}
            />
          </div>
          <span class="cm3-sidebar-task-copy">
            <span dir="auto">{record().session.title}</span>
            <Show when={recent}>
              <span class="cm3-sidebar-task-project" dir="auto">
                {record().projectName}
              </span>
            </Show>
          </span>
        </button>
        <button
          class="cm3-sidebar-session-pin"
          type="button"
          disabled={!sessions.session.pinsReady()}
          aria-pressed={sessions.session.isPinned(record().session)}
          aria-label={language.t(
            sessions.session.isPinned(record().session) ? "sidebar.session.unpin" : "sidebar.session.pin",
          )}
          title={language.t(
            sessions.session.isPinned(record().session) ? "sidebar.session.unpin" : "sidebar.session.pin",
          )}
          onClick={(event) => {
            const selector = event.currentTarget.closest(".cm3-sidebar-project-sessions")
              ? ".cm3-sidebar-project-sessions"
              : "section >"

            sessions.session.pin(record().session, !sessions.session.isPinned(record().session))
            queueMicrotask(() =>
              refs.nav
                ?.querySelector<HTMLButtonElement>(
                  `${selector} [data-session-id="${CSS.escape(record().session.id)}"] .cm3-sidebar-session-pin`,
                )
                ?.focus({ preventScroll: true }),
            )
          }}
        >
          <Icon
            name={sessions.session.isPinned(record().session) ? "push-pin-fill" : "push-pin"}
            style={{ width: "12.8px", height: "12.8px" }}
          />
        </button>
        <Show when={true}>
          <button
            class="cm3-sidebar-session-archive"
            type="button"
            aria-label={language.t("common.archive")}
            title={language.t("common.archive")}
            onClick={() => void sessions.session.archive(record().session)}
          >
            <Icon name="archive" size="small" />
          </button>
        </Show>
      </div>
    )
  }

  const renderDraft = (chat: Accessor<Extract<ProjectChat, { type: "draft" }>>) => (
    <div class="cm3-sidebar-session" data-draft-id={chat().tab.draftID} role="group" aria-label={chat().title}>
      <button
        class="cm3-sidebar-task"
        data-action="project-draft"
        type="button"
        data-active={activeChat(chat())}
        aria-current={activeChat(chat()) ? "page" : undefined}
        onKeyDown={navigateSearch}
        onClick={() => openChat(chat())}
      >
        <div class="size-4 shrink-0" aria-hidden="true">
          <Cm3Icon name="note-pencil" size={16} />
        </div>
        <span class="cm3-sidebar-task-copy">
          <span dir="auto">{chat().title}</span>
        </span>
        <span class="cm3-sidebar-draft-label">{language.t("sidebar.session.draft")}</span>
      </button>
      <Menu modal={false} placement="bottom-end">
        <Menu.Trigger
          class="cm3-sidebar-session-menu"
          type="button"
          aria-label={language.t("common.moreOptions")}
          title={language.t("common.moreOptions")}
        >
          <Icon name="outline-dots" size="small" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content>
            <Menu.Item
              onSelect={() => {
                const index = tabs.store.findIndex((tab) => tab.type === "draft" && tab.draftID === chat().tab.draftID)

                if (index !== -1) tabs.removeTab(index)
                queueMicrotask(() => refs.search?.focus({ preventScroll: true }))
              }}
            >
              {language.t("sidebar.session.discardDraft")}
            </Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
    </div>
  )

  return (
    <>
      <button
        ref={(element) => (refs.toggle = element)}
        class="cm3-navigation-toggle"
        type="button"
        aria-label={language.t("command.sidebar.toggle")}
        aria-expanded={state.navigation}
        onClick={() => {
          setState("navigation", true)
          queueMicrotask(() =>
            Array.from(refs.nav?.querySelectorAll<HTMLButtonElement>("button") ?? [])
              .find((element) => element.getClientRects().length > 0)
              ?.focus(),
          )
        }}
      >
        <Cm3Icon name="sidebar-simple" />
      </button>
      <Show when={state.navigation}>
        <button
          class="cm3-navigation-backdrop"
          type="button"
          tabIndex={-1}
          aria-label={language.t("quietCompanion.closeNavigation")}
          onClick={closeNavigation}
        />
      </Show>
      <aside
        ref={(element) => (refs.nav = element)}
        class="cm3-sidebar"
        style={{ "--cm3-sidebar-expanded-width": `${sidebar.width}px` }}
        data-open={state.navigation}
        data-collapsed={sidebar.collapsed}
        aria-label={language.t("sidebar.nav.projectsAndSessions")}
        on:keydown={(event) => {
          if (event.defaultPrevented || event.isComposing) return

          if (event.key === "Escape") {
            if (!state.navigation || (event.target instanceof HTMLElement && event.target.isContentEditable)) return
            event.preventDefault()
            event.stopPropagation()
            closeNavigation()

            return
          }

          if (event.key !== "Tab" || !state.navigation || !refs.toggle?.offsetParent) return

          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]",
            ),
          ).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0)

          const first = controls[0]
          const last = controls.at(-1)

          if (event.shiftKey && event.target === first) {
            event.preventDefault()
            last?.focus()
          }

          if (!event.shiftKey && event.target === last) {
            event.preventDefault()
            first?.focus()
          }
        }}
      >
        <div class="cm3-sidebar-brand">
          <img
            class="cm3-sidebar-logo"
            src={theme.mode() === "dark" ? cookieMonsterBannerDark : cookieMonsterBannerLight}
            alt={language.t("quietCompanion.brand")}
            width={720}
            height={180}
          />
          <button
            class="cm3-sidebar-collapse"
            type="button"
            aria-label={language.t("command.sidebar.toggle")}
            title={language.t("command.sidebar.toggle")}
            aria-expanded={!sidebar.collapsed}
            onClick={() => setSidebar("collapsed", (value) => !value)}
          >
            <Cm3Icon name="sidebar-simple" />
          </button>
          <button
            class="cm3-navigation-close"
            type="button"
            aria-label={language.t("quietCompanion.closeNavigation")}
            onClick={closeNavigation}
          >
            <Cm3Icon name="x" />
          </button>
        </div>
        <div class="cm3-sidebar-content">
          <button
            class="cm3-sidebar-action"
            type="button"
            onClick={create}
            disabled={!home.server.focused() || projectPending()}
          >
            <Cm3Icon name="note-pencil" />
            {language.t("quietCompanion.newTask")}
          </button>
          <button
            class="cm3-sidebar-action"
            type="button"
            aria-pressed={scheduling.isOpen()}
            data-action="scheduling"
            onClick={() => {
              scheduling.open()
              setState("navigation", false)
            }}
          >
            <Cm3Icon name="clock" />
            {language.t("schedules.title")}
          </button>
          <label class="cm3-sidebar-search">
            <Cm3Icon name="magnifying-glass" />
            <input
              ref={(element) => (refs.search = element)}
              type="search"
              value={state.search}
              onInput={(event) => setState("search", event.currentTarget.value)}
              onKeyDown={navigateSearch}
              placeholder={language.t("quietCompanion.search")}
              aria-label={language.t("quietCompanion.searchThreads")}
            />
          </label>
          <div class="cm3-sidebar-scroll">
            <section aria-label={language.t("sidebar.session.open")}>
              <p class="cm3-sidebar-section">{language.t("sidebar.session.open")}</p>
              <div class="cm3-sidebar-tabs" ref={props.onTabsMount} />
            </section>
            <CmProjects
              projects={projects}
              onOpenProjectNewSession={openTask}
              onSelectProject={home.project.select}
              onActivateProject={closeNavigation}
              renderProjectSessions={(conn, project) => {
                const limitKey = () => JSON.stringify([ServerConnection.key(conn), pathKey(project.worktree)])
                const group = () => projectSessions().get(pathKey(project.worktree)) ?? []
                const limit = () => sessionLimits[limitKey()] ?? PROJECT_SESSIONS_PAGE

                const visible = () => {
                  const page = group().slice(0, limit())
                  const active = group().find(activeChat)

                  if (!active || page.includes(active)) return page

                  // Keep the active chat within the page size without advancing Show more.
                  return [...page.slice(0, -1), active]
                }

                return (
                  <Show when={ServerConnection.key(conn) === sessions.session.server()}>
                    <div class="cm3-sidebar-project-sessions">
                      <For each={visible().map((chat) => chat.key)}>
                        {(key) => {
                          const chat = createMemo(() => group().find((chat) => chat.key === key))

                          const draft = () => {
                            const value = chat()

                            return value?.type === "draft" ? value : undefined
                          }

                          const record = () => {
                            const value = chat()

                            return value?.type === "session" ? value.record : undefined
                          }

                          return (
                            <>
                              <Show when={draft()}>{renderDraft}</Show>
                              <Show when={record()}>{(record) => renderSession(record)}</Show>
                            </>
                          )
                        }}
                      </For>
                      <Show when={group().length > limit()}>
                        <button
                          class="cm3-sidebar-action"
                          type="button"
                          data-action="project-sessions-show-more"
                          onClick={() => setSessionLimits(limitKey(), limit() + PROJECT_SESSIONS_PAGE)}
                        >
                          {language.t("common.showMore")}
                        </button>
                      </Show>
                    </div>
                  </Show>
                )
              }}
            />
            <button
              class="cm3-sidebar-action"
              type="button"
              onClick={() => {
                const conn = home.server.focused()

                if (!conn) return
                pickDirectory({
                  server: conn,
                  onSelect: (result) => {
                    if (!result) return
                    const directories = Array.isArray(result) ? result : [result]
                    home.project.add(conn, directories)

                    if (directories[0]) openTask(conn, directories[0])
                  },
                })
              }}
            >
              <Cm3Icon name="plus" />
              {language.t("command.project.open")}
            </button>
            <Show when={pinnedRecords().length > 0}>
              <section aria-label={language.t("sidebar.session.pinned")}>
                <p class="cm3-sidebar-section">{language.t("sidebar.session.pinned")}</p>
                <For each={pinnedRecords()}>{(record) => renderSession(() => record, true)}</For>
              </section>
            </Show>
          </div>
          <div class="cm3-sidebar-footer">
            <WppAuthControl />
            <button type="button" onClick={projects.utility.help}>
              <Cm3Icon name="question" />
              {language.t("sidebar.help")}
            </button>
            <button type="button" onClick={openSettings}>
              <Cm3Icon name="gear" />
              {language.t("quietCompanion.settings")}
            </button>
          </div>
        </div>
        <ResizeHandle
          class="cm3-sidebar-resize"
          direction="horizontal"
          size={sidebar.width}
          min={220}
          max={480}
          onResize={(width) => setSidebar("width", width)}
          role="separator"
          aria-label={language.t("sidebar.resize")}
          aria-orientation="vertical"
          aria-valuemin={220}
          aria-valuemax={480}
          aria-valuenow={sidebar.width}
          tabIndex={sidebar.collapsed ? -1 : 0}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
            event.preventDefault()
            const rtl = getComputedStyle(event.currentTarget).direction === "rtl"
            const delta = (event.key === "ArrowRight") !== rtl ? 10 : -10
            setSidebar("width", (width) => Math.min(480, Math.max(220, width + delta)))
          }}
        />
      </aside>
    </>
  )
}
