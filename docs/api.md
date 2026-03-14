# OpenClaw Tenants API 文档

Base URL: `http://<host>:<port>/api/openclaw`

---

## 1. 初始化 Agent

为用户创建专属 agent 和独立 workspace。前端必须在此接口返回成功后才能调用聊天接口。

### 请求

```
POST /api/openclaw/init
Content-Type: application/json
```

#### 请求体

| 字段     | 类型   | 必填 | 说明                     |
| -------- | ------ | ---- | ------------------------ |
| `userId` | string | ✅   | 用户唯一标识，长度 1–64 |

```json
{
  "userId": "10001"
}
```

### 响应

#### 200 — 初始化成功

首次创建：

```json
{
  "ok": true,
  "agentId": "10001",
  "workspace": "./tenants/10001/workspace",
  "created": true
}
```

已存在（幂等）：

```json
{
  "ok": true,
  "agentId": "10001",
  "workspace": "./tenants/10001/workspace",
  "created": false
}
```

| 字段        | 类型    | 说明                                |
| ----------- | ------- | ----------------------------------- |
| `ok`        | boolean | 是否成功                            |
| `agentId`   | string  | 规范化后的 agent 标识               |
| `workspace` | string  | 用户独立工作目录路径                |
| `created`   | boolean | `true` 首次创建，`false` 已存在    |

#### 400 — 参数不合法

```json
{
  "ok": false,
  "error": "userId 必填，且长度为 1–64"
}
```

#### 500 — 服务端错误

```json
{
  "ok": false,
  "error": "创建目录或写配置失败"
}
```

---

## 2. 聊天（OpenAI 兼容）

完全兼容 OpenAI Chat Completions API，可直接使用 OpenAI SDK 对接。通过 `model` 字段传入用户标识，格式为 `openclaw:<userId>`。

### 请求

```
POST /v1/chat/completions
Content-Type: application/json
```

#### 请求体

| 字段          | 类型    | 必填 | 说明                                            |
| ------------- | ------- | ---- | ----------------------------------------------- |
| `model`       | string  | ✅   | 格式 `"openclaw:<userId>"`，如 `"openclaw:10001"` |
| `messages`    | array   | ✅   | 消息数组，格式同 OpenAI                         |
| `stream`      | boolean | ❌   | 是否流式返回，默认 `false`                      |
| `temperature` | number  | ❌   | 温度参数                                        |
| 其他字段      | any     | ❌   | 透传至 OpenAI 兼容接口的其他参数                |

```json
{
  "model": "openclaw:10001",
  "messages": [
    { "role": "user", "content": "你好" }
  ],
  "stream": false,
  "temperature": 0.7
}
```

`messages` 中每项结构：

| 字段      | 类型   | 必填 | 说明                                |
| --------- | ------ | ---- | ----------------------------------- |
| `role`    | string | ✅   | `"system"` / `"user"` / `"assistant"` |
| `content` | string | ✅   | 消息内容                            |

### 响应

#### 200 — 成功

直接透传 OpenAI 兼容格式的响应体：

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "你好！有什么可以帮你的？"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 15,
    "total_tokens": 25
  }
}
```

#### 400 — 参数错误（OpenAI 错误格式）

```json
{
  "error": {
    "message": "messages 必填且不能为空数组",
    "type": "invalid_request_error",
    "param": "messages",
    "code": null
  }
}
```

#### 404 — Agent 不存在

```json
{
  "error": {
    "message": "agent \"10001\" 不存在，请先调用 /api/openclaw/init",
    "type": "invalid_request_error",
    "param": "user",
    "code": "agent_not_found"
  }
}
```

> 前端收到 404 时，建议自动重新调用一次 `/api/openclaw/init`，成功后再重试聊天。

#### 502 — 网关转发失败

```json
{
  "error": {
    "message": "OpenClaw 转发失败",
    "type": "server_error",
    "param": null,
    "code": null
  }
}
```

---

## 前端接入示例

```typescript
const API_BASE = '/api/openclaw'
const userId = getCurrentUserId()

// 1. 页面加载时初始化
const initRes = await fetch(`${API_BASE}/init`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId }),
})
const initData = await initRes.json()
if (!initData.ok) throw new Error('聊天服务初始化失败，请重试')

// 2. 发送消息（标准 OpenAI 兼容）
const chatRes = await fetch('/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: `openclaw:${userId}`,
    messages: [{ role: 'user', content: '你好' }],
  }),
})
const chatData = await chatRes.json()
console.log(chatData.choices[0].message.content)

// 也可直接使用 OpenAI SDK
import OpenAI from 'openai'
const client = new OpenAI({ baseURL: 'http://localhost:3000/v1', apiKey: 'unused' })
const completion = await client.chat.completions.create({
  model: `openclaw:${userId}`,
  messages: [{ role: 'user', content: '你好' }],
})
```

---

## 错误处理建议

| 场景           | 前端行为                           |
| -------------- | ---------------------------------- |
| init 失败      | 提示"聊天服务初始化失败，请重试"   |
| chat 返回 404  | 自动重新调用 init 一次，再重试     |
| chat 返回 502  | 提示"聊天服务异常，请稍后重试"     |
| 网络异常       | 提示"网络异常，请检查网络连接"     |
