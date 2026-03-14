import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import JSON5 from 'json5'
import { withLock } from './lock-service'

export interface AgentEntry {
  id: string
  workspace: string
}

export interface AgentsConfig {
  list: AgentEntry[]
}

const AGENTS_CONFIG_PATH = process.env.AGENTS_CONFIG_PATH
  || `${process.env.HOME}/.openclaw/generated/agents.json5`

const MAIN_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH
  || `${process.env.HOME}/.openclaw/openclaw.json`

export function getAgentsConfigPath(): string {
  return AGENTS_CONFIG_PATH
}

export async function readAgentsConfig(): Promise<AgentsConfig> {
  try {
    const content = await readFile(AGENTS_CONFIG_PATH, 'utf-8')
    return JSON5.parse(content) as AgentsConfig
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return { list: [] }
    }
    throw err
  }
}

export function findAgent(config: AgentsConfig, agentId: string): AgentEntry | undefined {
  return config.list.find((a) => a.id === agentId)
}

/**
 * 原子写入 agents.json5：先写 .tmp 再 rename
 */
export async function addAgent(agent: AgentEntry): Promise<void> {
  await withLock(async () => {
    const config = await readAgentsConfig()

    if (findAgent(config, agent.id)) {
      return // 已存在，幂等返回
    }

    config.list.push(agent)

    const dir = dirname(AGENTS_CONFIG_PATH)
    await mkdir(dir, { recursive: true })

    const tmpPath = AGENTS_CONFIG_PATH + '.tmp'
    await writeFile(tmpPath, JSON5.stringify(config, null, 2), 'utf-8')
    await rename(tmpPath, AGENTS_CONFIG_PATH)

    // touch 主配置以触发 OpenClaw 热加载
    await touchMainConfig()
  })
}

async function touchMainConfig(): Promise<void> {
  try {
    const content = await readFile(MAIN_CONFIG_PATH)
    await writeFile(MAIN_CONFIG_PATH, content)
  } catch {
    // 主配置不存在时忽略
  }
}
