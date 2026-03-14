const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL
  || 'http://127.0.0.1:18789'

const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || ''

export interface ChatRequest {
  messages: Array<{ role: string; content: string }>
  stream?: boolean
  temperature?: number
  [key: string]: unknown
}

export async function proxyChatRequest(
  agentId: string,
  body: ChatRequest,
): Promise<Response> {
  const { messages, stream, temperature, ...rest } = body

  const payload = {
    ...rest,
    model: `openclaw:${agentId}`,
    messages,
    stream: stream ?? false,
    ...(temperature !== undefined ? { temperature } : {}),
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (OPENCLAW_TOKEN) {
    headers['Authorization'] = `Bearer ${OPENCLAW_TOKEN}`
  }

  const response = await fetch(`${OPENCLAW_GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })

  return response
}
