// Counting semaphore that bounds how many holders run a guarded section at once. Its first use
// bounds concurrent worker spawns (max from O1_CODE_MAX_SPAWNS); with max=1 it also serves as a
// plain FIFO mutex (e.g. clipboardGate in controller-injection.ts serializing system-clipboard
// access). Split out from worker-pool.ts (like worker-slot.ts) so it loads without the Electron
// runtime and unit-tests directly. Leak-free: release() hands the permit straight to the next
// waiter, otherwise returns it to the pool. Waiters are FIFO.

export class SpawnGate {
  private permits: number
  private readonly waiters: Array<() => void> = []

  constructor(max: number) {
    this.permits = Math.max(1, max)
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()

    if (this.permits > 0) {
      this.permits--

      return
    }

    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener("abort", abort)
        resolve()
      }

      const abort = () => {
        const index = this.waiters.indexOf(grant)

        if (index !== -1) this.waiters.splice(index, 1)
        reject(signal?.reason ?? new DOMException("Acquisition cancelled", "AbortError"))
      }

      this.waiters.push(grant)
      signal?.addEventListener("abort", abort, { once: true })
    })
  }

  release(): void {
    const next = this.waiters.shift()

    if (next) next()
    else this.permits++
  }
}
