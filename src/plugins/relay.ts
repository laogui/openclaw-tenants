import fp from 'fastify-plugin'
import { getRelayServer } from '../services/relay/relay-server'
import { getRelayClient } from '../services/relay/relay-client'

export type RelayMode = 'direct' | 'relay-server' | 'relay-client'

const RELAY_MODE = (process.env.RELAY_MODE || 'direct') as RelayMode
const RELAY_WS_PORT = parseInt(process.env.RELAY_WS_PORT || '8080', 10)

declare module 'fastify' {
  interface FastifyInstance {
    relayMode: RelayMode
  }
}

export default fp(async (fastify) => {
  fastify.decorate('relayMode', RELAY_MODE)

  if (RELAY_MODE === 'relay-server') {
    const server = getRelayServer()
    server.start(fastify, RELAY_WS_PORT)
    fastify.addHook('onClose', () => server.stop())
    fastify.log.info(`Relay mode: relay-server (WS port ${RELAY_WS_PORT})`)
  } else if (RELAY_MODE === 'relay-client') {
    const client = getRelayClient()
    client.connect().catch((err) => {
      fastify.log.error(err, 'Failed to start relay client')
    })
    fastify.addHook('onClose', () => client.stop())
    fastify.log.info('Relay mode: relay-client')
  } else {
    fastify.log.info('Relay mode: direct')
  }
})
