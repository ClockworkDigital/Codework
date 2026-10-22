import { app } from "electron"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export function resolveAppIdentity(channel: Channel, branded: boolean, packaged: boolean) {
  if (branded) {
    return {
      name: packaged ? "Codework" : "Codework Dev",
      appId: packaged ? "digital.clockwork.codework" : "digital.clockwork.codework.dev",
    }
  }
  if (!packaged) {
    return {
      name: "OpenCode Dev",
      appId: "ai.opencode.desktop.dev",
    }
  }
  return {
    name: {
      dev: "OpenCode Dev",
      beta: "OpenCode Beta",
      prod: "OpenCode",
    }[channel],
    appId: {
      dev: "ai.opencode.desktop.dev",
      beta: "ai.opencode.desktop.beta",
      prod: "ai.opencode.desktop",
    }[channel],
  }
}

export const APP_IDENTITY = resolveAppIdentity(CHANNEL, import.meta.env.CODEWORK_BRAND, app.isPackaged)
export const UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev"
