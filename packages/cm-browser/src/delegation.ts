import type { ToolContext } from "./tool"
import type { BrowserPort } from "./port"
import { OPERATION_TIMEOUT_MS, type BrowserState, type Response } from "./protocol"

export type BrowserDelegation = (
  input: {
    parentSessionID: string
    childSessionID: string
    executionID: string
    browserTabIDs: readonly string[]
    abort: AbortSignal
    ask: ToolContext["ask"]
  },
  output: { defer(cleanup: () => Promise<void>): void; acknowledge(): void },
) => Promise<void>

export function browserDelegation(port: BrowserPort): BrowserDelegation {
  return async (input, output) => {
    output.defer(async () => {
      const response = await port.send(
        input.parentSessionID,
        { op: "revoke_tabs", executionID: input.executionID },
        AbortSignal.timeout(OPERATION_TIMEOUT_MS),
      )
      requireDelegation(response, input.executionID, false)
    })

    input.abort.throwIfAborted()
    const tabIDs = [...input.browserTabIDs]
    await input.ask({
      permission: "browser_delegate_tabs",
      patterns: [...tabIDs],
      always: [],
      metadata: { childSessionID: input.childSessionID, tabIDs: [...tabIDs] },
    })
    input.abort.throwIfAborted()
    const response = await port.send(
      input.parentSessionID,
      { op: "grant_tabs", executionID: input.executionID, childSessionID: input.childSessionID, tabIDs },
      input.abort,
    )
    requireDelegation(response, input.executionID, true)
    input.abort.throwIfAborted()
    output.acknowledge()
  }
}

function requireDelegation(response: Response<BrowserState>, executionID: string, active: boolean) {
  if (!response.ok) throw new Error(`Browser delegation failed: ${response.error}`)
  const delegation: unknown = response.result.delegation
  if (
    !delegation ||
    typeof delegation !== "object" ||
    Array.isArray(delegation) ||
    Object.keys(delegation).length !== 2 ||
    !("executionID" in delegation) ||
    delegation.executionID !== executionID ||
    !("active" in delegation) ||
    delegation.active !== active
  ) {
    throw new Error("Browser delegation acknowledgement did not match the task scope")
  }
}
