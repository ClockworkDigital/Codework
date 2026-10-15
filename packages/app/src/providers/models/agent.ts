export function hasCustomAgent(items: Array<{ native?: boolean }>) {
  return items.some((item) => item.native === false)
}

export function resolveAgent<T extends { name: string }>(items: T[], name?: string, buildOnly = false) {
  if (buildOnly) return items.find((item) => item.name === "build")

  return items.find((item) => item.name === name) ?? items.find((item) => item.name === "build") ?? items[0]
}
