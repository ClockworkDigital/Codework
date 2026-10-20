export function desktopIdentity(channel: "dev" | "beta" | "prod") {
  if (process.env.CM_BRAND === "1") {
    return { appId: "com.ogilvy.cookiemonster", productName: "CookieMonster", packageName: "cookiemonster" }
  }

  return {
    appId: channel === "prod" ? "ai.opencode.desktop" : `ai.opencode.desktop.${channel}`,
    productName: channel === "prod" ? "OpenCode" : channel === "beta" ? "OpenCode Beta" : "OpenCode Dev",
    packageName: channel === "prod" ? "opencode" : `opencode-${channel}`,
  }
}
