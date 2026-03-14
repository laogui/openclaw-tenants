const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL
  || 'http://127.0.0.1:18789'

const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || ''

const MODEL_PREFIX = 'openclaw:'

export async function proxyChatRequest(
  body: Record<string, unknown>,
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (OPENCLAW_TOKEN) {
    headers['Authorization'] = `Bearer ${OPENCLAW_TOKEN}`
  }

  // 从 model 提取 userId，自动注入 user 字段以保持稳定会话
  const payload = { ...body }
  const model = payload.model as string | undefined
  if (model?.startsWith(MODEL_PREFIX) && !payload.user) {
    payload.user = model.slice(MODEL_PREFIX.length)
  }

  return fetch(`${OPENCLAW_GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })
}
