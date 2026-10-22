import { Spinner } from "@opencode-ai/ui/spinner"
import type { ComponentProps } from "solid-js"

export { codeworkLoading } from "@opencode-ai/ui/loading"

export function CodeworkLoading(props: ComponentProps<typeof Spinner>) {
  return <Spinner {...props} />
}
