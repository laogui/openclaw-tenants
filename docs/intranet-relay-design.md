# OpenClaw 内网穿透 WebSocket Relay 方案

版本：v1.0
适用场景：OpenClaw 部署在内网，外网用户通过外网服务器访问

---

## 1. 问题分析

| 维度 | 现状（云端部署） | 新场景（内网部署） |
|------|------------------|---------------------|
| OpenClaw 位置 | 云服务器 | 内网机器（无公网 IP） |
| Node 后端 | 与 OpenClaw 同机 | 内网，与 OpenClaw 同网段 |
| 用户访问 | 直连后端 | 无法直连内网 |
| 用户 ID | 统一 | 外网用户 ID ≠ 内网 userId（需映射） |

**核心约束**：内网无法被外网主动连接，必须由内网主动向外网发起连接建立隧道。

---

## 2. 架构方案

```
外网用户 (浏览器/App)
    │
    │ POST /v1/chat/completions
    │ model = "openclaw:<externalUserId>"
    │
    ▼
┌─────────────────────────────────────┐
│  外网服务器 (Public Relay Server)    │
│  - Fastify HTTP 接口 (面向用户)      │
│  - WebSocket Server (面向内网)       │
│  - 请求队列 + 响应路由              │
│  - 外网 userId → 内网 userId 映射   │
└────────────┬────────────────────────┘
             │ WebSocket (由内网主动连接)
             │ wss://relay.example.com/relay
             │
        ─────┼───── 防火墙 / NAT ─────
             │
┌────────────┴────────────────────────┐
│  内网 Relay Client                   │
│  - 主动连接外网 WS Server            │
│  - 接收请求 → 调用 OpenClaw          │
│  - 将 OpenClaw 响应回传外网          │
│  - 自动重连 + 心跳                   │
└────────────┬────────────────────────┘
             │ HTTP POST /v1/chat/completions
             ▼
┌─────────────────────────────────────┐
│  OpenClaw Gateway (内网)             │
│  127.0.0.1:18789                     │
│  - 自动创建 agent                   │
│  - 独立 workspace / memory          │
└─────────────────────────────────────┘
```

### 2.1 为什么用 WebSocket 而非其他方案

| 方案 | 优劣 |
|------|------|
| **SSH 隧道** | OpenClaw 官方推荐，但需要外网服务器能 SSH 到内网，或内网做反向 SSH（运维复杂） |
| **Tailscale** | 好方案但需要两端都装 Tailscale，对部分客户不适用 |
| **frp/ngrok** | 引入第三方依赖，商用场景可能有安全合规问题 |
| **WebSocket Relay** ✅ | 纯应用层、无额外依赖、内网主动出站（防火墙友好）、支持流式 |

**关键点**：OpenClaw Gateway 本身就是 WebSocket 协议（所有客户端通过 WS 连接），但这里不是直接暴露 OpenClaw 的 WS 协议给外网用户，而是通过我们自己的 Relay 隧道来转发 HTTP API 请求。用户接口仍然是标准 OpenAI 兼容的 HTTP POST。

---

## 3. 用户 ID 映射

外网用户 ID 和内网 OpenClaw 的 userId 可能不同，需要映射：

```
外网用户请求: model = "openclaw:ext_user_001"
                         ↓ 映射
内网转发请求: model = "openclaw:tenant_a_ext_user_001"
```

### 映射策略

**方案 A — 前缀策略（推荐，零配置）**：

```typescript
// 外网 → 内网 userId 映射
const internalUserId = `${TENANT_PREFIX}_${externalUserId}`
// 例: "company_a_10001"
```

**方案 B — 映射表**：外网服务器维护 `externalId → internalId` 的映射表（适合需要精确控制的场景）。

---

## 4. 模块设计

### 4.1 整体项目结构

```
openclaw-tenants/
├── src/
│   ├── app.ts                          # 现有 Fastify 应用
│   ├── services/
│   │   ├── chat-proxy-service.ts       # 现有：直连 OpenClaw 代理
│   │   └── relay/
│   │       ├── relay-protocol.ts       # Relay 通信协议定义
│   │       ├── relay-server.ts         # 外网：WS Server + HTTP 入口
│   │       └── relay-client.ts         # 内网：WS Client + OpenClaw 调用
│   ├── routes/
│   │   └── v1/chat/completions.ts      # 现有路由（需适配两种模式）
│   └── plugins/
└── docs/
```

### 4.2 Relay 协议（relay-protocol.ts）

内外网之间的 WebSocket 通信使用 JSON 帧：

```typescript
// 请求帧：外网 → 内网
interface RelayRequest {
  type: 'chat.request'
  id: string                    // 请求唯一 ID（用于响应路由）
  payload: {
    model: string               // "openclaw:<internalUserId>"
    messages: Message[]
    stream?: boolean
    temperature?: number
    [key: string]: unknown
  }
}

// 响应帧：内网 → 外网（非流式）
interface RelayResponse {
  type: 'chat.response'
  id: string                    // 对应请求 ID
  status: number
  headers: Record<string, string>
  body: string                  // JSON 字符串
}

// 流式帧：内网 → 外网（流式场景）
interface RelayStreamChunk {
  type: 'chat.stream.chunk'
  id: string
  data: string                  // SSE data 行内容
}

interface RelayStreamEnd {
  type: 'chat.stream.end'
  id: string
}

// 心跳
interface RelayPing {
  type: 'ping'
  ts: number
}

interface RelayPong {
  type: 'pong'
  ts: number
}

// 认证
interface RelayAuth {
  type: 'auth'
  token: string                 // Relay 共享密钥
}

interface RelayAuthResult {
  type: 'auth.result'
  ok: boolean
}
```

### 4.3 外网 Relay Server（relay-server.ts）

```typescript
// 核心职责：
// 1. 启动 WebSocket Server，等待内网 Relay Client 连接
// 2. 提供 HTTP POST /v1/chat/completions 接口给外网用户
// 3. 将用户请求通过 WS 转发给内网，等待内网响应后回传用户
// 4. 处理 userId 映射（外网 → 内网）
// 5. 支持流式（SSE）透传

class RelayServer {
  // 内网 client 的 WS 连接（1:1 或 1:N）
  private internalClients: Map<string, WebSocket>

  // 等待响应的请求队列
  private pendingRequests: Map<string, PendingRequest>

  // 处理外网用户的 HTTP 请求
  async handleChatRequest(body: Record<string, unknown>): Promise<Response> {
    // 1. 提取 externalUserId，映射为 internalUserId
    // 2. 构造 RelayRequest，通过 WS 发送给内网
    // 3. 等待内网返回 RelayResponse（Promise + timeout）
    // 4. 返回给用户
  }

  // 处理流式请求
  async handleStreamRequest(body: Record<string, unknown>, reply: FastifyReply) {
    // 1. 映射 userId
    // 2. 发送 RelayRequest（stream: true）
    // 3. 监听 RelayStreamChunk 事件，逐块写入 SSE
    // 4. 收到 RelayStreamEnd 后关闭
  }
}
```

### 4.4 内网 Relay Client（relay-client.ts）

```typescript
// 核心职责：
// 1. 主动连接外网 WS Server（出站连接，无需开放入站端口）
// 2. 接收 RelayRequest，调用本地 OpenClaw Gateway
// 3. 将 OpenClaw 响应封装为 RelayResponse/RelayStreamChunk 回传
// 4. 断线自动重连 + 心跳保活

class RelayClient {
  private ws: WebSocket
  private reconnectInterval: number = 3000

  // 连接外网 Relay Server
  async connect(relayServerUrl: string, authToken: string) {
    // 1. 建立 WS 连接
    // 2. 发送 auth 帧
    // 3. 等待 auth.result
    // 4. 开始监听请求
  }

  // 处理收到的请求
  async handleRequest(req: RelayRequest) {
    // 1. 调用 proxyChatRequest（复用现有逻辑）
    // 2. 如果 stream，逐块发 RelayStreamChunk
    // 3. 如果非 stream，整体发 RelayResponse
  }

  // 自动重连
  private scheduleReconnect() {
    // 指数退避 + 最大间隔
  }
}
```

---

## 5. 运行模式

通过环境变量控制运行模式：

```bash
# 模式 1：直连（现有模式，OpenClaw 在本地或云端）
RELAY_MODE=direct
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789

# 模式 2：外网 Relay Server
RELAY_MODE=relay-server
RELAY_WS_PORT=8080                    # WS 监听端口（内网连接用）
RELAY_AUTH_TOKEN=shared-secret        # Relay 认证密钥
TENANT_PREFIX=company_a               # userId 前缀映射
# 不需要 OPENCLAW_GATEWAY_URL（外网没有 OpenClaw）

# 模式 3：内网 Relay Client
RELAY_MODE=relay-client
RELAY_SERVER_URL=wss://relay.example.com/relay
RELAY_AUTH_TOKEN=shared-secret        # 同上
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789
```

同一套代码，三种部署形态：

| 模式 | 部署位置 | 提供 HTTP API | 连接 OpenClaw | 连接 Relay WS |
|------|----------|--------------|---------------|---------------|
| `direct` | 任意 | ✅ | ✅ 直连 | ❌ |
| `relay-server` | **外网** | ✅ | ❌ | ✅ 作为 WS Server |
| `relay-client` | **内网** | ❌ | ✅ 直连 | ✅ 作为 WS Client |

---

## 6. 时序图

### 6.1 非流式请求

```
外网用户          外网 Relay Server          内网 Relay Client         OpenClaw
  │                    │                          │                      │
  │─ POST /v1/chat ──→│                          │                      │
  │  model=openclaw:X  │                          │                      │
  │                    │─ WS: chat.request ──────→│                      │
  │                    │  id=req_001              │                      │
  │                    │  model=openclaw:pfx_X    │                      │
  │                    │                          │─ POST /v1/chat ────→│
  │                    │                          │  model=openclaw:pfx_X│
  │                    │                          │  user=pfx_X          │
  │                    │                          │←── chat result ─────│
  │                    │←── WS: chat.response ───│                      │
  │                    │    id=req_001            │                      │
  │←── chat result ───│                          │                      │
```

### 6.2 流式请求（SSE）

```
外网用户          外网 Relay Server          内网 Relay Client         OpenClaw
  │                    │                          │                      │
  │─ POST /v1/chat ──→│                          │                      │
  │  stream=true       │─ WS: chat.request ──────→│                      │
  │                    │                          │─ POST /v1/chat ────→│
  │                    │                          │  stream=true         │
  │                    │                          │←── SSE chunk 1 ─────│
  │                    │←── WS: stream.chunk ────│                      │
  │←── SSE chunk 1 ───│                          │                      │
  │                    │                          │←── SSE chunk 2 ─────│
  │                    │←── WS: stream.chunk ────│                      │
  │←── SSE chunk 2 ───│                          │                      │
  │                    │                          │←── SSE [DONE] ──────│
  │                    │←── WS: stream.end ──────│                      │
  │←── SSE [DONE] ────│                          │                      │
```

---

## 7. 安全设计

### 7.1 Relay 通道认证

```
内网 Client → 外网 Server: WS 连接
Server → Client: { type: "auth.challenge", nonce: "..." }
Client → Server: { type: "auth", token: HMAC(nonce, RELAY_AUTH_TOKEN) }
Server → Client: { type: "auth.result", ok: true }
```

### 7.2 安全清单

| 项目 | 措施 |
|------|------|
| WS 通道 | 使用 `wss://`（TLS 加密） |
| Relay 认证 | 共享密钥 + HMAC 挑战 |
| OpenClaw token | 仅存在于内网，不暴露 |
| 用户输入 | 外网服务器验证 model 格式 |
| 超时 | 请求超时 60s，避免挂起 |
| 重连 | 指数退避，避免风暴 |

---

## 8. 技术选型

在现有依赖基础上增加：

```json
{
  "dependencies": {
    "ws": "^8.18.0"             // WebSocket（Fastify 生态兼容）
  },
  "devDependencies": {
    "@types/ws": "^8.5.0"
  }
}
```

或使用 `@fastify/websocket`（更贴合现有 Fastify 框架）。

---

## 9. OpenClaw 配置（内网侧）

内网的 OpenClaw 配置与现有方案相同，无需变更：

```json5
{
  gateway: {
    mode: "local",
    port: 18789,
    bind: "loopback",
    auth: { token: "YOUR_GATEWAY_TOKEN" },
    reload: { mode: "hybrid", debounceMs: 300 },
    http: {
      endpoints: {
        chatCompletions: { enabled: true }
      }
    }
  }
}
```

> **注意**：OpenClaw 官方文档确认 `/v1/chat/completions` HTTP 端点默认关闭，需要通过 `gateway.http.endpoints.chatCompletions.enabled: true` 显式开启。

---

## 10. 部署拓扑

```
┌─── 外网 ──────────────────────────────┐
│                                        │
│  用户浏览器 ──→ Nginx ──→ Relay Server │
│                 :443       :3001       │
│                            WS :8080   │
│                                        │
└────────────────────┬───────────────────┘
                     │ wss://:8080 (出站)
              ───── 防火墙 ─────
                     │
┌────────────────────┴───────────────────┐
│                                        │
│  Relay Client ──→ OpenClaw Gateway     │
│                   127.0.0.1:18789      │
│                                        │
└─── 内网 ──────────────────────────────┘
```

---

## 11. 实施步骤

1. **定义 Relay 协议**（relay-protocol.ts）— 类型定义
2. **实现 Relay Client**（内网侧）— 复用现有 `proxyChatRequest`
3. **实现 Relay Server**（外网侧）— 新增 WS Server + 请求路由
4. **修改路由层** — 根据 `RELAY_MODE` 选择走直连还是 Relay
5. **加入认证和心跳**
6. **加入流式支持**
7. **加入重连和错误处理**
8. **联调测试**

---

## 12. 一句话结论

**"内网 Relay Client 主动出站连接外网 Relay Server 的 WebSocket，形成安全隧道；外网用户的 HTTP 请求通过隧道转发到内网 OpenClaw，响应原路返回。用户接口保持 OpenAI 兼容不变，同一套代码通过环境变量切换直连/Relay 模式。"**
