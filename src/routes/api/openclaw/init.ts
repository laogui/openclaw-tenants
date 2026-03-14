import { FastifyPluginAsync } from 'fastify'
import { isValidUserId } from '../../../services/normalize'
import { initAgent } from '../../../services/agent-service'

const initRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post('/init', async (request, reply) => {
    const { userId } = request.body as { userId?: string }

    if (!isValidUserId(userId)) {
      return reply.status(400).send({
        ok: false,
        error: 'userId 必填，且长度为 1–64',
      })
    }

    try {
      const result = await initAgent(userId)
      return reply.send(result)
    } catch (err: any) {
      if (err.code === 'EACCES') {
        return reply.status(500).send({
          ok: false,
          error: '创建目录或写配置失败：权限不足',
        })
      }
      request.log.error(err, 'init agent failed')
      return reply.status(500).send({
        ok: false,
        error: '创建目录或写配置失败',
      })
    }
  })
}

export default initRoute
