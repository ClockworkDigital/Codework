import type { WebContents } from "electron"
import type { WppAuthState } from "../shared/wpp-auth"

export type WppIntegration = {
  model: string
  start(chatMode: "assistant" | "agent", onAuth: (state: WppAuthState) => void): Promise<void>
  auth: {
    get(): WppAuthState
    check(): Promise<WppAuthState>
  }
  requestLogin(origin: string): Promise<void>
  toggleLogin(): void
  toggleWindows(): boolean
  isLoggedWorker(contents: WebContents): boolean
  setWorkerLogWriter(
    // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Matches the optional backend diagnostic callback; values go only to the log sink.
    writer: (id: number, event: string, details: Record<string, unknown>, level?: "info" | "warn" | "error") => void,
  ): void
}

// The build replaces this module only when WPP is explicitly enabled.
export const wpp: WppIntegration | undefined = undefined
