import fp from 'fastify-plugin'

const DEFAULT_ALLOW_HEADERS = 'Content-Type, Authorization'
const ALLOW_METHODS = 'GET,POST,OPTIONS'
const MAX_AGE_SECONDS = '86400'

export default fp(async (fastify) => {
  fastify.addHook('onSend', async (request, reply, payload) => {
    const requestHeaders = request.headers['access-control-request-headers']

    reply.header('Access-Control-Allow-Origin', '*')
    reply.header('Access-Control-Allow-Methods', ALLOW_METHODS)
    reply.header(
      'Access-Control-Allow-Headers',
      typeof requestHeaders === 'string' && requestHeaders.length > 0
        ? requestHeaders
        : DEFAULT_ALLOW_HEADERS,
    )
    reply.header('Access-Control-Max-Age', MAX_AGE_SECONDS)

    return payload
  })

  fastify.options('*', async (_request, reply) => {
    return reply.code(204).send()
  })
})
