/**
 * 进程内写配置串行化锁
 */
let pending: Promise<void> = Promise.resolve()

export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = pending.then(fn, fn)
  pending = next.then(() => {}, () => {})
  return next
}
