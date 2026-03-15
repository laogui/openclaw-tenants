import { createHmac } from 'node:crypto'
import WebSocket from 'ws'
import {
  RelayFrame,
  RelayRequest,
  encodeFrame,
  decodeFrame,
} from './relay-protocol'
import { proxyChatRequest } from '../chat-proxy-service'

const RELAY_SERVER_URL = process.env.RELAY_SERVER_URL || ''
const RELAY_AUTH_TOKEN = process.env.RELAY_AUTH_TOKEN || ''

const RECONNECT_BASE_MS = 3_000
const RECONNECT_MAX_MS = 60_000
const HEARTBEAT_TIMEOUT_MS = 45_000

export class RelayClient {
  private ws: WebSocket | null = null
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  async connect(): Promise<void> {
    if (!RELAY_SERVER_URL) {
      throw new Error('RELAY_SERVER_URL is not configured')
    }
    this.stopped = false
    this.doConnect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.stopHeartbeatWatch()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  private doConnect(): void {
    console.log(`[RelayClient] Connecting to ${RELAY_SERVER_URL} ...`)
    const ws = new WebSocket(RELAY_SERVER_URL)

    ws.on('open', () => {
      console.log('[RelayClient] WebSocket connected, waiting for auth challenge...')
    })

    ws.on('message', (raw) => {
      let frame: RelayFrame
      try {
        frame = decodeFrame(raw.toString())
      } catch {
        console.warn('[RelayClient] Invalid frame received')
        return
      }
      this.handleFrame(ws, frame)
    })

    ws.on('close', () => {
      console.log('[RelayClient] Disconnected')
      this.stopHeartbeatWatch()
      this.ws = null
      this.scheduleReconnect()
    })

    ws.on('error', (err) => {
      console.error('[RelayClient] WS error:', err.message)
    })

    this.ws = ws
  }

  private handleFrame(ws: WebSocket, frame: RelayFrame): void {
    switch (frame.type) {
      case 'auth.challenge': {
        const hmac = createHmac('sha256', RELAY_AUTH_TOKEN)
          .update(frame.nonce)
          .digest('hex')
        ws.send(encodeFrame({ type: 'auth', token: hmac }))
        break
      }

      case 'auth.result': {
        if (frame.ok) {
          console.log('[RelayClient] Authenticated')
          this.reconnectAttempts = 0
          this.startHeartbeatWatch()
        } else {
          console.error('[RelayClient] Authentication failed')
          ws.close()
        }
        break
      }

      case 'chat.request': {
        this.handleChatRequest(ws, frame).catch((err) => {
          console.error('[RelayClient] Error handling request:', err)
        })
        break
      }

      case 'ping': {
        ws.send(encodeFrame({ type: 'pong', ts: frame.ts }))
        this.resetHeartbeatWatch()
        break
      }

      default:
        break
    }
  }

  // ── 处理从外网转发来的 chat 请求 ──

  private async handleChatRequest(ws: WebSocket, req: RelayRequest): Promise<void> {
    try {
      const response = await proxyChatRequest(req.payload)

      if (req.payload.stream) {
        await this.handleStreamResponse(ws, req.id, response)
      } else {
        await this.handleNonStreamResponse(ws, req.id, response)
      }
    } catch (err: any) {
      ws.send(encodeFrame({
        type: 'chat.error',
        id: req.id,
        status: 502,
        message: err.message || 'OpenClaw request failed',
      }))
    }
  }

  private async handleNonStreamResponse(
    ws: WebSocket,
    requestId: string,
    response: Response,
  ): Promise<void> {
    const body = await response.text()
    const headers: Record<string, string> = {}
    response.headers.forEach((v, k) => {
      headers[k] = v
    })

    ws.send(encodeFrame({
      type: 'chat.response',
      id: requestId,
      status: response.status,
      headers,
      body,
    }))
  }

  private async handleStreamResponse(
    ws: WebSocket,
    requestId: string,
    response: Response,
  ): Promise<void> {
    if (!response.body) {
      ws.send(encodeFrame({
        type: 'chat.error',
        id: requestId,
        status: 502,
        message: 'No response body for stream',
      }))
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6)
            if (data === '[DONE]') {
              ws.send(encodeFrame({ type: 'chat.stream.end', id: requestId }))
              return
            }
            ws.send(encodeFrame({
              type: 'chat.stream.chunk',
              id: requestId,
              data,
            }))
          }
        }
      }

      // 处理 buffer 中剩余内容
      if (buffer.startsWith('data: ')) {
        const data = buffer.slice(6)
        if (data !== '[DONE]') {
          ws.send(encodeFrame({
            type: 'chat.stream.chunk',
            id: requestId,
            data,
          }))
        }
      }

      ws.send(encodeFrame({ type: 'chat.stream.end', id: requestId }))
    } catch (err: any) {
      ws.send(encodeFrame({
        type: 'chat.error',
        id: requestId,
        status: 502,
        message: err.message || 'Stream read error',
      }))
    }
  }

  // ── 自动重连（指数退避） ──

  private scheduleReconnect(): void {
    if (this.stopped) return

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_MS,
    )
    this.reconnectAttempts++
    console.log(`[RelayClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)

    this.reconnectTimer = setTimeout(() => {
      this.doConnect()
    }, delay)
  }

  // ── 心跳监测（如果长时间没收到 ping，说明连接可能已断） ──

  private startHeartbeatWatch(): void {
    this.resetHeartbeatWatch()
  }

  private resetHeartbeatWatch(): void {
    this.stopHeartbeatWatch()
    this.heartbeatTimer = setTimeout(() => {
      console.warn('[RelayClient] Heartbeat timeout, closing connection')
      this.ws?.close()
    }, HEARTBEAT_TIMEOUT_MS)
  }

  private stopHeartbeatWatch(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }
}

let relayClientInstance: RelayClient | null = null

export function getRelayClient(): RelayClient {
  if (!relayClientInstance) {
    relayClientInstance = new RelayClient()
  }
  return relayClientInstance
}
