import { FastifyPluginAsync } from 'fastify'
import { normalize } from '../../../services/normalize'
import { readAgentsConfig, findAgent } from '../../../services/config-service'
import { proxyChatRequest, ChatRequest } from '../../../services/chat-proxy-service'

const MODEL_PREFIX = 'openclaw:'

const completionsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post('/completions', async (request, reply) => {
    const { model, messages, ...rest } = request.body as {
      model?: string
      messages?: Array<{ role: string; content: string }>
    } & Record<string, unknown>

    // 从 model 字段提取 userId: "openclaw:<userId>"
    if (!model || !model.startsWith(MODEL_PREFIX)) {
      return reply.status(400).send({
        error: {
          message: `model 字段必填，格式为 "openclaw:<userId>"`,
          type: 'invalid_request_error',
          param: 'model',
          code: null,
        },
      })
    }

    const userId = model.slice(MODEL_PREFIX.length)
    if (!userId || userId.length > 64) {
      return reply.status(400).send({
        error: {
          message: 'model 中的 userId 不合法，长度为 1–64',
          type: 'invalid_request_error',
          param: 'model',
          code: null,
        },
      })
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return reply.status(400).send({
        error: {
          message: 'messages 必填且不能为空数组',
          type: 'invalid_request_error',
          param: 'messages',
          code: null,
        },
      })
    }

    const agentId = normalize(userId)

    const config = await readAgentsConfig()
    if (!findAgent(config, agentId)) {
      return reply.status(404).send({
        error: {
          message: `agent "${agentId}" 不存在，请先调用 /api/openclaw/init`,
          type: 'invalid_request_error',
          param: 'model',
          code: 'agent_not_found',
        },
      })
    }

    try {
      const response = await proxyChatRequest(agentId, {
        messages,
        ...rest,
      } as ChatRequest)

      // 透传状态码
      reply.status(response.status)

      // 透传响应头
      const contentType = response.headers.get('content-type')
      if (contentType) {
        reply.header('content-type', contentType)
      }

      // 原封不动透传 body stream
      if (response.body) {
        return reply.send(response.body)
      }

      // 无 body 时回退
      const text = await response.text()
      return reply.send(text)
    } catch (err: any) {
      request.log.error(err, 'chat proxy failed')
      return reply.status(502).send({
        error: {
          message: 'OpenClaw 转发失败',
          type: 'server_error',
          param: null,
          code: null,
        },
      })
    }
  })
}

export default completionsRoute
