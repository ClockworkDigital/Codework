export * as CmAePlugin from "./plugin.workerd.js"

// The desktop bundle loader needs native files and dynamic imports unavailable in workerd.
export const plugins = [] as const
