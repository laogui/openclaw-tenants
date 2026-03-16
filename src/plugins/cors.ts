import fp from 'fastify-plugin'

const DEFAULT_ALLOW_HEADERS = 'Content-Type, Authorization'
const ALLOW_METHODS = 'GET,POST,OPTIONS'
const MAX_AGE_SECONDS = '86400'

function getAllowOrigin(originHeader: string | undefined): string | undefined {
  const configured = process.env.CORS_ORIGIN?.trim()

  if (!configured || configured === '*') {
    return '*'
  }

  if (!originHeader) {
    return undefined
  }

  const allowedOrigins = configured
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

  return allowedOrigins.includes(originHeader) ? originHeader : undefined
}

export default fp(async (fastify) => {
  fastify.addHook('onSend', async (request, reply, payload) => {
    const requestOrigin = typeof request.headers.origin === 'string'
      ? request.headers.origin
      : undefined
    const allowOrigin = getAllowOrigin(requestOrigin)
    const requestHeaders = request.headers['access-control-request-headers']

    if (allowOrigin) {
      reply.header('Access-Control-Allow-Origin', allowOrigin)
    }

    reply.header('Access-Control-Allow-Methods', ALLOW_METHODS)
    reply.header(
      'Access-Control-Allow-Headers',
      typeof requestHeaders === 'string' && requestHeaders.length > 0
        ? requestHeaders
        : DEFAULT_ALLOW_HEADERS,
    )
    reply.header('Access-Control-Max-Age', MAX_AGE_SECONDS)

    if (allowOrigin !== '*') {
      reply.header('Vary', 'Origin, Access-Control-Request-Headers')
    }

    return payload
  })

  fastify.options('*', async (_request, reply) => {
    return reply.code(204).send()
  })
})