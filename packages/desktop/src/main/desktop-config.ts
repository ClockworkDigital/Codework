import type { CmAePlugin } from "../cm-ae"

export function desktopConfigContent(browserPlugin?: string, aePlugin?: CmAePlugin) {
  const plugins = [browserPlugin, aePlugin].filter((plugin) => plugin !== undefined)
  return JSON.stringify({
    // Retired relay IDs stay disabled even when an older global config contains their seeds.
    disabled_providers: ["cookiemonster", "wpp", "o1-code"],
    ...(plugins.length ? { plugin: plugins } : {}),
    permission: {
      browser_read_state: "allow",
      browser_search_history: "allow",
      browser_open_history: "ask",
      // Lifecycle defaults come from the plugin config hook, below user policy.
      browser_navigate: "allow",
      browser_click: "allow",
      browser_hover: "allow",
      browser_drag: "allow",
      browser_select_option: "allow",
      browser_screenshot: "allow",
      browser_visual_action: "allow",
      browser_observe_console: "allow",
      browser_observe_network: "allow",
      browser_list_site_tools: "allow",
      browser_execute_site_tool: "allow",
      browser_fill: "allow",
      browser_press_key: "allow",
      browser_scroll: "allow",
      browser_wait_for_element: "allow",
      browser_wait_for_navigation: "allow",
    },
    lsp: true,
  })
}
