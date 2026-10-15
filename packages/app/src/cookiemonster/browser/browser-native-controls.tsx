import { Button } from "@opencode/ui/button"
import { IconButton } from "@opencode/ui/icon-button"
import { Icon } from "@opencode/ui/icon"
import { Menu } from "@opencode/ui/menu"
import { ItemLabel, ItemIndicator } from "@kobalte/core/dropdown-menu"
import { splitProps, type ComponentProps } from "solid-js"

export function BrowserButton(
  props: Omit<ComponentProps<typeof Button>, "variant"> & {
    variant?: ComponentProps<typeof Button>["variant"] | "primary" | "secondary"
  },
) {
  const [local, rest] = splitProps(props, ["variant"])

  return (
    <Button
      {...rest}
      variant={local.variant === "primary" ? "contrast" : local.variant === "secondary" ? "neutral" : local.variant}
    />
  )
}

export function BrowserIconButton(
  props: Omit<ComponentProps<typeof IconButton>, "icon"> & {
    icon: ComponentProps<typeof Icon>["name"]
    iconSize?: ComponentProps<typeof Icon>["size"]
  },
) {
  const [local, rest] = splitProps(props, ["icon", "iconSize"])

  return <IconButton {...rest} icon={<Icon name={local.icon} size={local.iconSize ?? "normal"} />} />
}

export const BrowserDropdownMenu = Object.assign((props: ComponentProps<typeof Menu>) => <Menu {...props} />, {
  ...Menu,
  ItemLabel,
  ItemIndicator,
})
