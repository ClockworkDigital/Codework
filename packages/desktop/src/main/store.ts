import electron from "electron"
import { rmSync } from "node:fs"
import { join } from "node:path"

import { requireStoreName } from "./store-keys"
import { deleteStoreFileIfEmpty } from "./store-cleanup"
import { BrowserStore } from "./browser/store"

const cache = new Map<string, BrowserStore>()

// Keep the private browser profile outside renderer storage.
export function getStore(name = "cm-browser") {
  requireStoreName(name)
  const cached = cache.get(name)

  if (cached) return cached

  if (name !== "cm-browser") throw new Error("Only the private browser store is supported")
  const next = new BrowserStore(join(electron.app.getPath("userData"), name))
  cache.set(name, next)

  return next
}

export async function removeStoreFileIfEmpty(name: string) {
  requireStoreName(name)

  if (await deleteStoreFileIfEmpty(electron.app.getPath("userData"), name)) cache.delete(name)
}

export function removeStoreFile(name: string) {
  requireStoreName(name)
  rmSync(join(electron.app.getPath("userData"), name), { force: true })
  cache.delete(name)
}
