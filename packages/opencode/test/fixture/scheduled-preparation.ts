import type { PluginModule } from "@opencode-ai/plugin"

const gates = new Map<string, ReturnType<typeof createGate>>()

function createGate() {
  return { ready: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
}

export function reserve(sessionID: string) {
  const gate = createGate()
  gates.set(sessionID, gate)
  return { ready: gate.ready.promise, release: () => gate.release.resolve() }
}

export default {
  id: "test.scheduled-preparation",
  server: async () => ({
    "chat.message": async (input) => {
      const gate = gates.get(input.sessionID)
      if (!gate) return
      gate.ready.resolve()
      await gate.release.promise
      gates.delete(input.sessionID)
    },
  }),
} satisfies PluginModule
