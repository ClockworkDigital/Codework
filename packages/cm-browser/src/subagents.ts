import type { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import type { BrowserPort } from "./port"
import { browserDelegation } from "./delegation"

export async function registerSubagents(ctx: Plugin.Context, port: BrowserPort) {
  const delegate = browserDelegation(port)
  await ctx.tool.transform((editor) => {
    const entry = editor.list().find((tool) => tool.name === "subagent" && !tool.options?.namespace)
    if (!entry) return
    editor.update(entry.id, (tool) => {
      if (!Schema.isSchema(tool.input) || !("fields" in tool.input))
        throw new Error("Unsupported subagent input schema")
      const input = Schema.Struct({
        // The native subagent owns these fields; keep its decoding and validation intact.
        ...(tool.input.fields as Schema.Struct.Fields),
        browser_tab_ids: Schema.optionalKey(
          Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/))).check(
            Schema.isMinLength(1),
            Schema.isMaxLength(16),
            Schema.isUnique(),
          ),
        ).annotate({
          description:
            "CM Browser tabs to lend to a NEW foreground subagent. Cannot be used with sessionID or background=true.",
        }),
      })
      const execute = tool.execute
      tool.input = input
      tool.execute = async (value: unknown, context) => {
        const args = Schema.decodeUnknownSync(input)(value)
        const tabs = args.browser_tab_ids
        if (!tabs?.length) return execute(args, context)
        if (("sessionID" in args && args.sessionID) || ("background" in args && args.background === true))
          throw new Error("Browser tabs can only be lent to a new foreground subagent")
        const cleanups: (() => Promise<void>)[] = []
        let child: string | undefined
        try {
          return await execute(args, {
            ...context,
            progress: async (update) => {
              if (typeof update.sessionID === "string" && !child) {
                child = update.sessionID
                let acknowledged = false
                await delegate(
                  {
                    parentSessionID: context.sessionID,
                    childSessionID: child,
                    executionID: context.id,
                    browserTabIDs: tabs,
                    abort: context.signal,
                    ask: (input) =>
                      ctx.permission.assert({
                        sessionID: context.sessionID,
                        action: input.permission,
                        resources: input.patterns,
                        save: input.always,
                        metadata: input.metadata,
                        source: { type: "tool", messageID: context.messageID, id: context.id },
                      }),
                  },
                  {
                    defer: (cleanup) => cleanups.push(cleanup),
                    acknowledge: () => {
                      acknowledged = true
                    },
                  },
                )
                if (!acknowledged) throw new Error("Browser tab delegation was not acknowledged")
              }
              await context.progress(update)
            },
          })
        } finally {
          for (const cleanup of cleanups.toReversed()) await cleanup()
        }
      }
    })
  })
}
