/**
 * userId -> agentId 规范化
 * 仅允许字母、数字、下划线、横杠，长度 1–64
 */
export function normalize(userId: string): string {
  const replaced = userId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return replaced.slice(0, 64)
}

export function isValidUserId(userId: unknown): userId is string {
  return typeof userId === 'string' && userId.length >= 1 && userId.length <= 64
}
