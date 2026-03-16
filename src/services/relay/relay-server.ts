import { createHmac, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { WebSocketServer, WebSocket } from 'ws'
import { FastifyInstance, FastifyReply } from 'fastify'
import {
  RelayFrame,
  RelayRequest,
  RelayResponse,
  createRequestId,
  encodeFrame,
  decodeFrame,
} from './relay-protocol'

const RELAY_AUTH_TOKEN = process.env.RELAY_AUTH_TOKEN || ''
const TENANT_PREFIX = process.env.TENANT_PREFIX || ''
const REQUEST_TIMEOUT_MS = 60_000
const HEARTBEAT_INTERVAL_MS = 30_000
const MODEL_PREFIX = 'openclaw:'

interface PendingRequest {
  resolve: (frame: RelayResponse) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class RelayServer {
  private wss: WebSocketServer | null = null
  private internalClient: WebSocket | null = null
  private authenticated = false
  private pendingRequests = new Map<string, PendingRequest>()
  private streamEmitter = new EventEmitter()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  start(fastify: FastifyInstance, port: number): void {
    this.wss = new WebSocketServer({ port })
    fastify.log.info(`Relay WS Server listening on port ${port}`)

    this.wss.on('connection', (ws: WebSocket) => {
      fastify.log.info('Internal relay client connected')
      this.authenticated = false

      // 发送认证挑战
      const nonce = randomUUID()
      ws.send(encodeFrame({ type: 'auth.challenge', nonce }))

      ws.on('message', (raw: WebSocket.RawData) => {
        let frame: RelayFrame
        try {
          frame = decodeFrame(raw.toString())
        } catch {
          fastify.log.warn('Invalid relay frame received')
          return
        }

        if (!this.authenticated) {
          if (frame.type === 'auth') {
            const expected = createHmac('sha256', RELAY_AUTH_TOKEN)
              .update(nonce)
              .digest('hex')
            if (frame.token === expected) {
              this.authenticated = true
              this.internalClient = ws
              ws.send(encodeFrame({ type: 'auth.result', ok: true }))
              fastify.log.info('Relay client authenticated')
              this.startHeartbeat(fastify, ws)
            } else {
              ws.send(encodeFrame({ type: 'auth.result', ok: false }))
              ws.close(4001, 'Authentication failed')
              fastify.log.warn('Relay client auth failed')
            }
          }
          return
        }

        this.handleFrame(frame)
      })

      ws.on('close', () => {
        fastify.log.info('Internal relay client disconnected')
        if (this.internalClient === ws) {
          this.internalClient = null
          this.authenticated = false
          this.stopHeartbeat()
          // 拒绝所有等待中的请求
          for (const [id, pending] of this.pendingRequests) {
            pending.reject(new Error('Relay client disconnected'))
            clearTimeout(pending.timer)
            this.pendingRequests.delete(id)
          }
        }
      })

      ws.on('error', (err: Error) => {
        fastify.log.error(err, 'Relay WS error')
      })
    })
  }

  stop(): void {
    this.stopHeartbeat()
    this.wss?.close()
  }

  // ── 外网用户非流式请求入口 ──

  async handleChatRequest(body: Record<string, unknown>): Promise<RelayResponse> {
    if (!this.internalClient || !this.authenticated) {
      return {
        type: 'chat.response',
        id: '',
        status: 503,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          error: {
            message: '内网 Relay 未连接',
            type: 'server_error',
            param: null,
            code: null,
          },
        }),
      }
    }

    const id = createRequestId()
    const payload = this.mapUserIdInPayload(body)

    const req: RelayRequest = {
      type: 'chat.request',
      id,
      payload: payload as RelayRequest['payload'],
    }

    this.internalClient.send(encodeFrame(req))

    return new Promise<RelayResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error('Relay request timeout'))
      }, REQUEST_TIMEOUT_MS)

      this.pendingRequests.set(id, { resolve, reject, timer })
    })
  }

  // ── 外网用户流式请求入口 ──

  async handleStreamRequest(
    body: Record<string, unknown>,
    reply: FastifyReply,
  ): Promise<void> {
    if (!this.internalClient || !this.authenticated) {
      reply.status(503).send({
        error: {
          message: '内网 Relay 未连接',
          type: 'server_error',
          param: null,
          code: null,
        },
      })
      return
    }

    const id = createRequestId()
    const payload = this.mapUserIdInPayload({ ...body, stream: true })

    const req: RelayRequest = {
      type: 'chat.request',
      id,
      payload: payload as RelayRequest['payload'],
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })

    const timeout = setTimeout(() => {
      this.streamEmitter.removeAllListeners(id)
      reply.raw.write('data: [DONE]\n\n')
      reply.raw.end()
    }, REQUEST_TIMEOUT_MS)

    this.streamEmitter.on(id, (frame: RelayFrame) => {
      if (frame.type === 'chat.stream.chunk') {
        reply.raw.write(`data: ${frame.data}\n\n`)
      } else if (frame.type === 'chat.stream.end') {
        reply.raw.write('data: [DONE]\n\n')
        reply.raw.end()
        clearTimeout(timeout)
        this.streamEmitter.removeAllListeners(id)
      } else if (frame.type === 'chat.error') {
        reply.raw.write(`data: ${JSON.stringify({ error: { message: frame.message } })}\n\n`)
        reply.raw.write('data: [DONE]\n\n')
        reply.raw.end()
        clearTimeout(timeout)
        this.streamEmitter.removeAllListeners(id)
      }
    })

    this.internalClient.send(encodeFrame(req))
  }

  // ── 内部帧处理 ──

  private handleFrame(frame: RelayFrame): void {
    switch (frame.type) {
      case 'chat.response': {
        const pending = this.pendingRequests.get(frame.id)
        if (pending) {
          clearTimeout(pending.timer)
          this.pendingRequests.delete(frame.id)
          pending.resolve(frame)
        }
        break
      }
      case 'chat.stream.chunk':
      case 'chat.stream.end':
      case 'chat.error': {
        this.streamEmitter.emit(frame.id, frame)
        break
      }
      case 'pong':
        break
    }
  }

  // ── userId 映射：外网 → 内网 ──

  private mapUserIdInPayload(body: Record<string, unknown>): Record<string, unknown> {
    const payload = { ...body }
    const model = payload.model as string | undefined
    if (model?.startsWith(MODEL_PREFIX) && TENANT_PREFIX) {
      const externalUserId = model.slice(MODEL_PREFIX.length)
      payload.model = `${MODEL_PREFIX}${TENANT_PREFIX}_${externalUserId}`
    }
    return payload
  }

  // ── 心跳 ──

  private startHeartbeat(fastify: FastifyInstance, ws: WebSocket): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encodeFrame({ type: 'ping', ts: Date.now() }))
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }
}

// 单例
let relayServerInstance: RelayServer | null = null

export function getRelayServer(): RelayServer {
  if (!relayServerInstance) {
    relayServerInstance = new RelayServer()
  }
  return relayServerInstance
}
