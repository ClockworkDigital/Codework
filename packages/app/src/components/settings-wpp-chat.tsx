import { Show, createResource, createSignal } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Switch } from "@opencode-ai/ui/switch"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { SettingsRow } from "./settings-row"
import { SettingsRowV2 } from "./settings-v2/parts/row"

export function SettingsWppChat(props: { modern?: boolean }) {
  const platform = usePlatform()
  const language = useLanguage()
  const [saving, setSaving] = createSignal(false)
  const [mode, { mutate }] = createResource(
    () => platform.wppChat,
    (api) => api.getMode(),
  )
  const change = async (checked: boolean) => {
    if (!platform.wppChat || saving()) return
    setSaving(true)
    try {
      const result = await platform.wppChat.setMode(checked ? "agent" : "assistant")
      mutate(result.mode)
      if (result.busy) showToast({ description: language.t("settings.general.wppChat.busy") })
    } catch {
      showToast({ description: language.t("settings.general.wppChat.failed") })
    } finally {
      setSaving(false)
    }
  }
  return (
    <Show when={platform.wppChat}>
      <Dynamic
        component={props.modern ? SettingsRowV2 : SettingsRow}
        title={language.t("settings.general.wppChat.title")}
        description={language.t("settings.general.wppChat.description")}
      >
        <Switch
          data-action="settings-wpp-chat-mode"
          hideLabel
          checked={mode() === "agent"}
          disabled={mode.loading || saving() || !mode()}
          onChange={(checked) => void change(checked)}
        >
          {language.t("settings.general.wppChat.title")}
        </Switch>
      </Dynamic>
    </Show>
  )
}
