import { FastifyPluginAsync } from 'fastify'
import { proxyChatRequest } from '../../../services/chat-proxy-service'

const completionsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post('/completions', async (request, reply) => {
    try {
      const response = await proxyChatRequest(request.body as Record<string, unknown>)

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
