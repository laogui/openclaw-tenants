import { test } from 'node:test'
import * as assert from 'node:assert'
import { Readable } from 'node:stream'
import Fastify from 'fastify'
import Cors from '../../src/plugins/cors'
import { RelayServer } from '../../src/services/relay/relay-server'
import { decodeFrame } from '../../src/services/relay/relay-protocol'
import { build } from '../helper'

test('cors preflight works for chat completions', async (t) => {
  const app = await build(t)

  const res = await app.inject({
    method: 'OPTIONS',
    url: '/v1/chat/completions',
    headers: {
      origin: 'http://localhost:3004',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type, authorization',
    },
  })

  assert.equal(res.statusCode, 204)
  assert.equal(res.headers['access-control-allow-origin'], '*')
  assert.equal(res.headers['access-control-allow-methods'], 'GET,POST,OPTIONS')
  assert.equal(res.headers['access-control-allow-headers'], 'content-type, authorization')
})

test('cors headers are included on normal responses', async (t) => {
  const app = await build(t)

  const res = await app.inject({
    method: 'GET',
    url: '/',
    headers: {
      origin: 'http://localhost:3004',
    },
  })

  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['access-control-allow-origin'], '*')
})

test('cors headers are included on streamed responses', async (t) => {
  const app = Fastify()
  void app.register(Cors)
  app.post('/stream', async (_request, reply) => {
    reply.header('content-type', 'text/event-stream')
    return Readable.from(['data: hello\n\n', 'data: [DONE]\n\n'])
  })
  await app.ready()
  t.after(() => void app.close())

  const res = await app.inject({
    method: 'POST',
    url: '/stream',
    headers: {
      origin: 'http://localhost:3004',
    },
  })

  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['access-control-allow-origin'], '*')
})

test('relay stream responses include cors headers', async () => {
  const relayServer = new RelayServer()
  let encodedFrame = ''
  let statusCode = 0
  let responseHeaders: Record<string, string> = {}

  ;(relayServer as any).authenticated = true
  ;(relayServer as any).internalClient = {
    send: (frame: string) => {
      encodedFrame = frame
    },
  }

  const reply = {
    raw: {
      writeHead: (status: number, headers: Record<string, string>) => {
        statusCode = status
        responseHeaders = headers
      },
      write: () => {},
      end: () => {},
    },
  }

  await relayServer.handleStreamRequest({
    model: 'openclaw:test-user',
    stream: true,
    messages: [{ role: 'user', content: 'ping' }],
  }, reply as any)

  assert.equal(statusCode, 200)
  assert.equal(responseHeaders['Access-Control-Allow-Origin'], '*')
  assert.equal(responseHeaders['Access-Control-Allow-Methods'], 'GET,POST,OPTIONS')

  const frame = decodeFrame(encodedFrame) as { type: 'chat.request'; id: string }
  assert.equal(frame.type, 'chat.request')
  ;(relayServer as any).streamEmitter.emit(frame.id, { type: 'chat.stream.end', id: frame.id })
})
