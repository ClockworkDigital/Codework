import type { WppAuthState } from "../shared/wpp-auth"

export type WppIntegration = {
  model: string
  start(chatMode: "assistant" | "agent", onAuth: (state: WppAuthState) => void): Promise<void>
  auth: {
    get(): WppAuthState
    check(): Promise<WppAuthState>
  }
  toggleLogin(): void
  toggleWindows(): boolean
  isLoggedWorker(contents: object): boolean
  setWorkerLogWriter(
    writer: (id: number, event: string, details: Record<string, unknown>, level?: "info" | "warn" | "error") => void,
  ): void
}

// The build replaces this module only when WPP is explicitly enabled.
export const wpp: WppIntegration | undefined = undefined
