import { test } from 'node:test'
import * as assert from 'node:assert'
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