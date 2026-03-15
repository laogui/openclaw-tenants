import { FastifyPluginAsync } from 'fastify'
import { proxyChatRequest } from '../../../services/chat-proxy-service'
import { getRelayServer } from '../../../services/relay/relay-server'

const completionsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post('/completions', async (request, reply) => {
    const body = request.body as Record<string, unknown>

    // relay-client 模式不提供 HTTP API（请求由内网 WS 接收处理）
    if (fastify.relayMode === 'relay-client') {
      return reply.status(404).send({
        error: {
          message: 'This instance runs in relay-client mode and does not serve HTTP API',
          type: 'invalid_request_error',
          param: null,
          code: null,
        },
      })
    }

    try {
      // relay-server 模式：通过 WS 隧道转发到内网
      if (fastify.relayMode === 'relay-server') {
        const relayServer = getRelayServer()

        if (body.stream) {
          await relayServer.handleStreamRequest(body, reply)
          return
        }

        const relayResp = await relayServer.handleChatRequest(body)
        reply.status(relayResp.status)
        for (const [k, v] of Object.entries(relayResp.headers)) {
          reply.header(k, v)
        }
        return reply.send(relayResp.body)
      }

      // direct 模式：直连 OpenClaw
      const response = await proxyChatRequest(body)

      reply.status(response.status)

      const contentType = response.headers.get('content-type')
      if (contentType) {
        reply.header('content-type', contentType)
      }

      if (response.body) {
        return reply.send(response.body)
      }

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
