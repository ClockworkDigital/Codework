export function cookieMonsterConfig(plugins: string[], content?: string, model?: string) {
  const config: unknown = content ? JSON.parse(content) : {}

  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid OpenCode config")
  const current = "plugins" in config ? config.plugins : []

  if (!Array.isArray(current)) throw new Error("Invalid OpenCode plugins")

  return JSON.stringify({
    ...(model ? { model } : {}),
    ...config,
    plugins: [
      ...current.filter((plugin) => plugin !== "-opencode.browser"),
      "-opencode.browser",
      ...plugins.filter((plugin) => !current.includes(plugin)),
    ],
  })
}
