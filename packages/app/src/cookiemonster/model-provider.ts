export function cookieMonsterModelProvider(providerID: string, family?: string) {
  if (providerID !== "cookiemonster") return

  if (family?.startsWith("claude")) return "anthropic"

  if (family?.startsWith("gpt")) return "openai"

  if (family?.startsWith("gemini")) return "google"
}
