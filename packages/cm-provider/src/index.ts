import { randomUUID } from "node:crypto"
import { Plugin, Model, Provider } from "@opencode/plugin"
import { Money } from "@opencode/schema/money"
import { MODEL_IDS, resolveModelProfile } from "./modelProfiles.mjs"

const runtimeID = (process.env.CM_RUNTIME_ID ??= randomUUID())
const providerID = Provider.ID.make("cookiemonster")

export default Plugin.define({
  id: "cookiemonster.provider",
  async setup(ctx) {
    await ctx.provider.transform((editor) => {
      if (editor.get(providerID)) return
      editor.add({
        info: {
          id: providerID,
          name: "CookieMonster",
          activation: "enabled",
          package: "@opencode/ai/providers/openai/responses",
          settings: {
            baseURL: `http://${process.env.O1_CODE_PROXY_HOST ?? "127.0.0.1"}:${process.env.O1_CODE_PROXY_PORT ?? "8787"}/v1`,
            apiKey: "cookiemonster-local",
          },
        },
        models: MODEL_IDS.map((id) => {
          const profile = resolveModelProfile(id)
          return {
            ...Model.Info.default(providerID, Model.ID.make(id)),
            capabilities: { tools: true, input: ["text", "image"], output: ["text", "image"] },
            family: Model.Family.make(
              id.startsWith("CM_Opus") ? "claude" : id.startsWith("CM_Gemini") ? "gemini" : "gpt",
            ),
            limit: { context: 250_000, output: 128_000 },
            cost: [
              {
                input: Money.USDPerMillionTokens.make(5),
                output: Money.USDPerMillionTokens.make(id.startsWith("CM_Opus") ? 25 : 30),
                cache: {
                  read: Money.USDPerMillionTokens.make(id.startsWith("CM_Opus") ? 0 : 0.5),
                  write: Money.USDPerMillionTokens.zero,
                },
              },
            ],
            ...("reasoningEfforts" in profile
              ? {
                  settings: { reasoningEffort: profile.defaultReasoningEffort },
                  variants: Object.keys(profile.reasoningEfforts).map((id) => ({
                    id: Model.VariantID.make(id),
                    settings: { reasoningEffort: id },
                  })),
                }
              : {}),
          }
        }),
      })
    })
    await ctx.session.hook(
      "model.request",
      (event) => {
        Object.keys(event.headers)
          .filter((key) => ["x-opencode-runtime-id", "x-opencode-client"].includes(key.toLowerCase()))
          .forEach((key) => delete event.headers[key])
        event.headers["x-opencode-runtime-id"] = runtimeID
        event.headers["x-opencode-client"] = process.env.OPENCODE_CLIENT ?? ctx.app.name
      },
      { providerID },
    )
  },
})
