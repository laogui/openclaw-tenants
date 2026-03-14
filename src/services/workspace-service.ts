import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const TENANTS_BASE = process.env.TENANTS_BASE_DIR || './tenants'

export function getWorkspacePath(agentId: string): string {
  return join(TENANTS_BASE, agentId, 'workspace')
}

export async function ensureWorkspace(agentId: string): Promise<string> {
  const wsPath = getWorkspacePath(agentId)
  await mkdir(wsPath, { recursive: true })
  return wsPath
}
