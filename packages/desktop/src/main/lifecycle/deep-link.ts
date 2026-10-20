export function consoleReturnWindow(value: string) {
  try {
    const url = new URL(value)

    if (url.protocol !== "opencode:" || url.hostname !== "console" || url.pathname !== "/authorized") return
    const id = url.searchParams.get("window")

    if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)) return

    return id
  } catch {
    return
  }
}

export function wppLoginOrigin(value: string) {
  try {
    const url = new URL(value)

    if (url.protocol !== "cookiemonster:" || url.hostname !== "wpp" || url.pathname !== "/login") return

    if (
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      [...url.searchParams.keys()].some((key) => key !== "origin")
    )
      return
    const origins = url.searchParams.getAll("origin")

    if (origins.length !== 1 || !origins[0] || origins[0].length > 256) return

    return origins[0]
  } catch {
    return
  }
}
