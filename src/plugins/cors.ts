import fp from 'fastify-plugin'

const DEFAULT_ALLOW_HEADERS = 'Content-Type, Authorization'
const ALLOW_METHODS = 'GET,POST,OPTIONS'
const MAX_AGE_SECONDS = '86400'

function getAllowHeaders(requestHeaders: string | string[] | undefined): string {
  if (Array.isArray(requestHeaders)) {
    return requestHeaders.join(', ')
  }

  if (typeof requestHeaders === 'string' && requestHeaders.length > 0) {
    return requestHeaders
  }

  return DEFAULT_ALLOW_HEADERS
}

export default fp(async (fastify) => {
  fastify.addHook('onRequest', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*')
    reply.header('Access-Control-Allow-Methods', ALLOW_METHODS)
    reply.header('Access-Control-Allow-Headers', getAllowHeaders(request.headers['access-control-request-headers']))
    reply.header('Access-Control-Max-Age', MAX_AGE_SECONDS)
  })

  fastify.options('*', async (_request, reply) => {
    return reply.code(204).send()
  })
})
