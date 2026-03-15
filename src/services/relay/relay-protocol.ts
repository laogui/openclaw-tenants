import { randomUUID } from 'node:crypto'

// ── 请求帧：外网 Relay Server → 内网 Relay Client ──

export interface RelayRequest {
  type: 'chat.request'
  id: string
  payload: {
    model: string
    messages: unknown[]
    stream?: boolean
    temperature?: number
    [key: string]: unknown
  }
}

// ── 响应帧：内网 → 外网（非流式） ──

export interface RelayResponse {
  type: 'chat.response'
  id: string
  status: number
  headers: Record<string, string>
  body: string
}

// ── 流式帧：内网 → 外网 ──

export interface RelayStreamChunk {
  type: 'chat.stream.chunk'
  id: string
  data: string
}

export interface RelayStreamEnd {
  type: 'chat.stream.end'
  id: string
}

// ── 错误帧 ──

export interface RelayError {
  type: 'chat.error'
  id: string
  status: number
  message: string
}

// ── 心跳 ──

export interface RelayPing {
  type: 'ping'
  ts: number
}

export interface RelayPong {
  type: 'pong'
  ts: number
}

// ── 认证 ──

export interface RelayAuthChallenge {
  type: 'auth.challenge'
  nonce: string
}

export interface RelayAuth {
  type: 'auth'
  token: string
}

export interface RelayAuthResult {
  type: 'auth.result'
  ok: boolean
}

// ── 联合类型 ──

export type RelayFrame =
  | RelayRequest
  | RelayResponse
  | RelayStreamChunk
  | RelayStreamEnd
  | RelayError
  | RelayPing
  | RelayPong
  | RelayAuthChallenge
  | RelayAuth
  | RelayAuthResult

// ── 工具函数 ──

export function createRequestId(): string {
  return `req_${randomUUID()}`
}

export function encodeFrame(frame: RelayFrame): string {
  return JSON.stringify(frame)
}

export function decodeFrame(data: string): RelayFrame {
  return JSON.parse(data) as RelayFrame
}
