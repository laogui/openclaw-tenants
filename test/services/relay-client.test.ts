import { EventEmitter } from 'node:events'
import * as assert from 'node:assert'
import test from 'node:test'
import WebSocket from 'ws'
import { RelayClient } from '../../src/services/relay/relay-client'

class FakeWebSocket extends EventEmitter {
	readyState: number = WebSocket.CONNECTING
  terminateCalls = 0
  closeCalls = 0

  constructor(readonly url: string) {
    super()
  }

  send(): void {}

  close(): void {
    this.closeCalls++
    this.readyState = WebSocket.CLOSED
    this.emit('close')
  }

  terminate(): void {
    this.terminateCalls++
    this.readyState = WebSocket.CLOSED
    this.emit('close')
  }
}

function installFakeTimers() {
  const originalSetTimeout = global.setTimeout
  const originalClearTimeout = global.clearTimeout
  let nextId = 1
  const tasks = new Map<number, () => void>()

  global.setTimeout = ((callback: (...args: any[]) => void) => {
    const id = nextId++
    tasks.set(id, () => callback())
    return id as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout

  global.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    tasks.delete(timer as unknown as number)
  }) as typeof clearTimeout

  return {
    count: (): number => tasks.size,
    runNext: (): void => {
      const next = tasks.entries().next()
      if (next.done) return

      const [id, callback] = next.value
      tasks.delete(id)
      callback()
    },
    restore: (): void => {
      global.setTimeout = originalSetTimeout
      global.clearTimeout = originalClearTimeout
    },
  }
}

test('relay client reconnects once after websocket close', async (t) => {
  process.env.RELAY_SERVER_URL = 'ws://relay.example.com/relay'
  const timers = installFakeTimers()
  const sockets: FakeWebSocket[] = []

  t.after(() => {
    delete process.env.RELAY_SERVER_URL
    timers.restore()
  })

  const client = new RelayClient((url) => {
    const socket = new FakeWebSocket(url)
    sockets.push(socket)
    return socket as unknown as WebSocket
  })

  await client.connect()
  assert.equal(sockets.length, 1)

  sockets[0].readyState = WebSocket.OPEN
  sockets[0].emit('open')
  sockets[0].emit('close')
  sockets[0].emit('close')

  assert.equal(timers.count(), 1)

  timers.runNext()
  assert.equal(sockets.length, 2)
})

test('relay client ignores stale socket close events after reconnect', async (t) => {
  process.env.RELAY_SERVER_URL = 'ws://relay.example.com/relay'
  const timers = installFakeTimers()
  const sockets: FakeWebSocket[] = []

  t.after(() => {
    delete process.env.RELAY_SERVER_URL
    timers.restore()
  })

  const client = new RelayClient((url) => {
    const socket = new FakeWebSocket(url)
    sockets.push(socket)
    return socket as unknown as WebSocket
  })

  await client.connect()
  const firstSocket = sockets[0]
  firstSocket.readyState = WebSocket.OPEN
  firstSocket.emit('open')
  firstSocket.emit('close')

  timers.runNext()
  const secondSocket = sockets[1]
  secondSocket.readyState = WebSocket.OPEN
  secondSocket.emit('open')
  firstSocket.emit('close')

  assert.equal((client as any).ws, secondSocket as unknown as WebSocket)
  assert.equal(timers.count(), 0)
})

test('relay client terminates errored websocket and schedules reconnect', async (t) => {
  process.env.RELAY_SERVER_URL = 'ws://relay.example.com/relay'
  const timers = installFakeTimers()
  const sockets: FakeWebSocket[] = []

  t.after(() => {
    delete process.env.RELAY_SERVER_URL
    timers.restore()
  })

  const client = new RelayClient((url) => {
    const socket = new FakeWebSocket(url)
    sockets.push(socket)
    return socket as unknown as WebSocket
  })

  await client.connect()
  const socket = sockets[0]
  socket.readyState = WebSocket.OPEN
  socket.emit('open')
  socket.emit('error', new Error('socket boom'))

  assert.equal(socket.terminateCalls, 1)
  assert.equal(timers.count(), 1)
})
