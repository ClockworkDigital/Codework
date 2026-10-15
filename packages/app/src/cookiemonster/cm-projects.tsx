import type { HomeProjectsController } from "@/home/projects/controller"
import { HomeProjectsView, type HomeProjectsViewProps } from "@/home/projects/view"

export function CmProjects(props: {
  projects: HomeProjectsController
  renderProjectSessions: NonNullable<HomeProjectsViewProps["renderProjectSessions"]>
  onOpenProjectNewSession: HomeProjectsViewProps["onOpenProjectNewSession"]
  onSelectProject: HomeProjectsViewProps["onSelectProject"]
  onActivateProject: () => void
  dropdown?: boolean
}) {
  return (
    <HomeProjectsView
      embedded
      dropdown={props.dropdown}
      language={props.projects.copy.language}
      servers={props.projects.server.list()}
      projects={props.projects.project.list()}
      recentlyClosed={props.projects.project.recentlyClosed()}
      selection={props.projects.selection.value()}
      homedir={props.projects.project.homedir()}
      serverHealth={props.projects.server.health}
      projectsForServer={props.projects.server.projects}
      collapsed={props.projects.server.collapsed}
      canRevealProject={props.projects.project.canReveal}
      hasUnread={props.projects.project.hasUnread}
      onWheel={() => {}}
      renderProjectSessions={props.renderProjectSessions}
      onChooseProject={props.projects.project.choose}
      onFocusServer={props.projects.server.focus}
      onAuthenticateServer={props.projects.server.authenticate}
      onToggleCollapsed={props.projects.server.toggleCollapsed}
      onEditServer={props.projects.server.edit}
      canRemoveServer={props.projects.server.canRemove}
      onRemoveServer={props.projects.server.remove}
      canHideServer={props.projects.server.canHide}
      onHideServer={props.projects.server.hide}
      onMoveProject={props.projects.project.move}
      onSelectProject={(server, directory) => {
        props.onSelectProject(server, directory)
        props.onActivateProject()
      }}
      onAddProjects={props.projects.project.add}
      onOpenProjectNewSession={props.onOpenProjectNewSession}
      canImportSession={props.projects.project.canImportSession}
      onImportSession={props.projects.project.importSession}
      onEditProject={props.projects.project.edit}
      onRevealProject={props.projects.project.reveal}
      onClearNotifications={props.projects.project.clearNotifications}
      onCloseProject={props.projects.project.close}
      onOpenSettings={props.projects.utility.settings}
      onOpenHelp={props.projects.utility.help}
    />
  )
}
