import { createEffect, onCleanup, type Accessor } from "solid-js"
import type { Data } from "@opencode/client/solid"

type Session = Pick<Data["session"], "cached" | "root" | "evict" | "active" | "permission" | "form">

/**
 * Releases the cached transcripts of session families that no open tab, session route, running work or attention
 * request keeps. A family is released once it has stayed unkept for `delay` with no transition pending, since an open
 * path can read a transcript before the transition that adds its tab or route commits. Late reads and events that
 * bring rows back to a released family start a new delay, so they cannot keep it cached.
 */
export function createSessionRetention(input: {
  session: Session
  /** Persisted tabs have loaded. */
  ready: Accessor<boolean>
  /** Sessions shown by open tabs or the current route. */
  visible: Accessor<readonly string[]>
  navigating: Accessor<boolean>
  delay: number
}) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  onCleanup(() => timers.forEach((timer) => clearTimeout(timer)))
  const unkept = () => new Set(input.ready() && !input.navigating() ? unkeptRoots(input.session, input.visible()) : [])

  const release = (root: string) => {
    timers.set(
      root,
      setTimeout(() => {
        timers.delete(root)
        input.session.evict(root)
        // Eviction keeps unacknowledged submissions and sessions still being created, and settling them need not
        // change the cached set this policy tracks. Retry while the family stays unkept and cached.
        if (!timers.has(root) && unkept().has(root)) release(root)
      }, input.delay),
    )
  }

  createEffect(() => {
    const roots = unkept()
    timers.forEach((timer, root) => {
      if (roots.has(root)) return
      clearTimeout(timer)
      timers.delete(root)
    })
    // A family that keeps receiving rows still releases at its first deadline.
    roots.forEach((root) => {
      if (!timers.has(root)) release(root)
    })
  })
}

function unkeptRoots(session: Session, visible: readonly string[]) {
  const kept = new Set(
    [...visible, ...session.active(), ...session.permission.sessions(), ...session.form.sessions()].map((id) =>
      session.root(id),
    ),
  )
  return session
    .cached()
    .map((id) => session.root(id))
    .filter((root) => !kept.has(root))
}
