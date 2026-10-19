import { useMutation, useQuery } from "@tanstack/solid-query"
import { Show, onCleanup } from "solid-js"
import { Switch } from "@opencode/ui/switch"
import { Button } from "@opencode/ui/button"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useServerCtx } from "@/runtime/server/runtime"
import type { ServerConnection } from "@/runtime/server/registry"
import { SettingsRow } from "@/settings/row"
import { showToast } from "@/shell/notifications/toast"

export function OnboardingSetting(props: { server: ServerConnection.Any }) {
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServerCtx(() => props.server)
  const query = useQuery(() => ({
    queryKey: [server().sdk.scope, "cm-onboarding"],
    enabled: server().sdk.connection.status() === "connected",
    queryFn: async () => {
      const api = server().sdk.api
      // Model discovery waits for plugin activation, including the skill policy transforms.
      await api.model.list()
      const [providers, skills] = await Promise.all([api.provider.list(), api.skill.list()])
      return {
        installed: providers.data.some((provider) => provider.id === "cookiemonster"),
        enabled: skills.data.some((skill) => skill.id === "cm-onboarding"),
      }
    },
  }))
  const update = useMutation(() => ({
    mutationFn: (enabled: boolean) => server().sdk.api.config.update({ skill: { id: "cm-onboarding", enabled } }),
    onSuccess: () => query.refetch(),
    onError: () =>
      showToast({
        variant: "error",
        title: language.t("cm.onboarding.saveFailed"),
        description: language.t("cm.onboarding.saveFailed.description"),
      }),
  }))
  onCleanup(server().sdk.event.on("skill.updated", () => void query.refetch()))

  return (
    <Show when={query.data?.installed || (platform.wppAuth && !query.data)}>
      <SettingsRow title={language.t("cm.onboarding.title")} description={language.t("cm.onboarding.description")}>
        <div data-action="settings-beginner-guidance" class="flex items-center gap-2">
          <Show when={query.isError}>
            <Button variant="ghost-muted" onClick={() => void query.refetch()}>
              {language.t("cm.onboarding.retry")}
            </Button>
          </Show>
          <Switch
            hideLabel
            checked={query.data?.enabled ?? true}
            disabled={query.isPending || query.isError || query.isFetching || update.isPending}
            onChange={(enabled) => update.mutate(enabled)}
          >
            {language.t("cm.onboarding.title")}
          </Switch>
        </div>
      </SettingsRow>
    </Show>
  )
}
