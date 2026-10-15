import { Show, createMemo } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Icon } from "@opencode/ui/icon"
import { Keybind } from "@opencode/ui/keybind"
import { ProviderModelIcon } from "@/providers/models/provider-group"
import { Tooltip } from "@opencode/ui/tooltip"
import { ComposerEditor } from "./editor/editor"
import { ModelSelectorPopover } from "@/providers/models/select-dialog"
import { DialogSelectModelUnpaid } from "@/providers/models/unpaid"
import { formatKeybind, useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import type { ComposerModel } from "./model"
import { usePlatform } from "@/runtime/platform/platform"
import { projectSettingsKey, useSettings } from "@/settings/model"
import { useWorkspaceLocation } from "@/workspaces/location"
import { useServerSDK } from "@/runtime/server/client"
import { Cm3Icon } from "@/cookiemonster/cm3-icon"
import { cookieMonsterModelProvider } from "@/cookiemonster/model-provider"

export function Composer(props: {
  class?: string
  model: ComposerModel
  borderUnderlay?: boolean
  readOnly?: boolean
  suggestionBoundary?: () => HTMLElement | undefined
}) {
  const dialog = useDialog()
  const command = useCommand()
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()
  const location = useWorkspaceLocation()
  const sdk = useServerSDK()
  const project = () => projectSettingsKey(sdk.scope, location().current?.project.id)
  const accepting = () => settings.permissions.autoApproves(project())

  return (
    <div class="flex flex-col gap-3">
      <ComposerEditor
        controller={props.model}
        borderUnderlay={props.borderUnderlay}
        readOnly={props.readOnly}
        class={props.class}
        modelControlsVisible={!props.model.model.loading}
        attachKeybind={command.keybindParts("file.attach")}
        attachShortcut={command.keybind("file.attach")}
        alternateKeybind={[formatKeybind("mod", language.t), "↵"]}
        exitShellKeybind={[formatKeybind("esc", language.t)]}
        suggestionBoundary={props.suggestionBoundary}
        permissionControl={
          <Show when={platform.browserPanel}>
            <Button
              type="button"
              role="switch"
              aria-checked={accepting()}
              aria-label={language.t("command.permissions.autoaccept.enable")}
              title={language.t("command.permissions.autoaccept.enable")}
              variant="ghost-muted"
              size="normal"
              class="prompt-permission-toggle shrink-0"
              onClick={() => {
                const key = project()
                const active = !accepting()

                if (!key) {
                  settings.permissions.setAutoApproveDefault(active)

                  return
                }

                settings.permissions.setAutoApproveOverride(
                  key,
                  active === settings.permissions.autoApproveDefault() ? undefined : active,
                )
              }}
            >
              <Cm3Icon name={accepting() ? "toggle-right-fill" : "toggle-left"} size={24} />
              <span>{language.t("command.permissions.autoaccept.enable")}</span>
            </Button>
          </Show>
        }
        modelControl={
          <ComposerModelControl
            loading={props.model.model.loading}
            paid={props.model.model.paid}
            title={language.t("command.model.choose")}
            keybind={command.keybindParts("model.choose")}
            model={props.model.model.selection}
            provider={props.model.model.selection.current()?.provider}
            modelName={props.model.model.selection.current()?.name ?? language.t("dialog.model.select.title")}
            onClose={props.model.restoreFocus}
            onUnpaidClick={() => dialog.show(() => <DialogSelectModelUnpaid model={props.model.model.selection} />)}
          />
        }
      />
    </div>
  )
}

function ComposerModelControl(props: {
  loading: boolean
  paid: boolean
  title: string
  keybind: string[]
  model: ComposerModel["model"]["selection"]
  provider?: { id: string; canonical?: string; name: string }
  modelName: string
  onClose: () => void
  onUnpaidClick: () => void
}) {
  const shouldAnimate = createMemo<boolean>((previous) => previous ?? props.loading)
  const mobile = createMediaQuery("(max-width: 767px)")

  const content = () => (
    <>
      <Show when={props.provider}>
        {(provider) => (
          <ProviderModelIcon
            provider={{
              ...provider(),
              canonical:
                cookieMonsterModelProvider(provider().id, props.model.current()?.family) ?? provider().canonical,
            }}
            class="shrink-0 opacity-40 transition-opacity duration-150 group-hover:opacity-100"
          />
        )}
      </Show>
      <span class="truncate leading-4">{props.modelName}</span>
      <span class="-ml-0.5 -mr-1 flex shrink-0">
        <Icon name="chevron-down" />
      </span>
    </>
  )

  return (
    <Show when={!props.loading}>
      <Tooltip
        inactive={mobile()}
        placement="top"
        gutter={4}
        value={
          <>
            {props.title}
            <Keybind keys={props.keybind} variant="neutral" />
          </>
        }
      >
        <Show
          when={props.paid || mobile()}
          fallback={
            <Button
              data-action="composer-model"
              data-control-type="dialog"
              variant="ghost-muted"
              size="normal"
              class="min-w-0 max-w-[220px] justify-start ![font-weight:440] group"
              classList={{ "animate-in fade-in": shouldAnimate() }}
              style={{ height: "28px" }}
              onClick={props.onUnpaidClick}
            >
              {content()}
            </Button>
          }
        >
          <ModelSelectorPopover
            model={props.model}
            unpaid={!props.paid}
            trigger={(triggerProps) => (
              <Button
                {...triggerProps}
                variant="ghost-muted"
                size="normal"
                style={{ height: "28px" }}
                class="min-w-0 max-w-[220px] justify-start ![font-weight:440] group"
                classList={{ "animate-in fade-in": shouldAnimate() }}
                data-action="composer-model"
                data-control-type={mobile() ? "drawer" : "popover"}
              >
                {content()}
              </Button>
            )}
            onClose={props.onClose}
          />
        </Show>
      </Tooltip>
    </Show>
  )
}
