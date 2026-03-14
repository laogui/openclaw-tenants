import { normalize } from './normalize'
import { readAgentsConfig, findAgent, addAgent } from './config-service'
import { ensureWorkspace, getWorkspacePath } from './workspace-service'

export interface InitResult {
  ok: boolean
  agentId: string
  workspace: string
  created: boolean
}

export async function initAgent(userId: string): Promise<InitResult> {
  const agentId = normalize(userId)
  const config = await readAgentsConfig()

  if (findAgent(config, agentId)) {
    return {
      ok: true,
      agentId,
      workspace: getWorkspacePath(agentId),
      created: false,
    }
  }

  const workspace = await ensureWorkspace(agentId)

  await addAgent({ id: agentId, workspace })

  return {
    ok: true,
    agentId,
    workspace,
    created: true,
  }
}
