# OpenClaw Tenants API 文档

Base URL: `http://<host>:3001`

本服务是一个纯透传代理，将请求原样转发到 OpenClaw Gateway。OpenClaw 会自动为用户创建 agent 和 workspace，无需手动初始化。

---

## 聊天（OpenAI 兼容）

完全兼容 OpenAI Chat Completions API，可直接使用 OpenAI SDK 对接。通过 `model` 字段传入用户标识，格式为 `openclaw:<userId>`。

后端会自动从 `model` 中提取 `userId`，注入到请求的 `user` 字段，以保持稳定的会话关联。

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
| `stream`      | boolean | ❌   | 是否流式返回（SSE），默认 `false`               |
| `temperature` | number  | ❌   | 温度参数                                        |
| 其他字段      | any     | ❌   | 原样透传至 OpenClaw Gateway                     |

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

#### 非流式 — 200

直接透传 OpenClaw Gateway 返回的 OpenAI 兼容格式响应体：

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

#### 流式 — 200 SSE

当 `stream: true` 时，响应为 `text/event-stream`，逐块透传 OpenClaw Gateway 的 SSE 数据：

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"你"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"好"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

#### 错误响应

所有错误均透传 OpenClaw Gateway 返回的原始错误，格式遵循 OpenAI 错误规范：

```json
{
  "error": {
    "message": "具体错误信息",
    "type": "invalid_request_error",
    "param": null,
    "code": null
  }
}
```

---

## 前端接入示例

### 方式一：fetch

```typescript
const BASE_URL = 'http://localhost:3001'
const userId = getCurrentUserId()

// 非流式
const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: `openclaw:${userId}`,
    messages: [{ role: 'user', content: '你好' }],
  }),
})
const data = await res.json()
console.log(data.choices[0].message.content)

// 流式
const streamRes = await fetch(`${BASE_URL}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: `openclaw:${userId}`,
    messages: [{ role: 'user', content: '你好' }],
    stream: true,
  }),
})
const reader = streamRes.body!.getReader()
const decoder = new TextDecoder()
while (true) {
  const { done, value } = await reader.read()
  if (done) break
  const chunk = decoder.decode(value)
  // 解析 SSE data: 行
  for (const line of chunk.split('\n')) {
    if (line.startsWith('data: ') && line !== 'data: [DONE]') {
      const json = JSON.parse(line.slice(6))
      const content = json.choices[0]?.delta?.content
      if (content) process.stdout.write(content)
    }
  }
}
```

### 方式二：OpenAI SDK

```typescript
import OpenAI from 'openai'

const userId = getCurrentUserId()
const client = new OpenAI({
  baseURL: 'http://localhost:3001/v1',
  apiKey: 'unused',
})

// 非流式
const completion = await client.chat.completions.create({
  model: `openclaw:${userId}`,
  messages: [{ role: 'user', content: '你好' }],
})
console.log(completion.choices[0].message.content)

// 流式
const stream = await client.chat.completions.create({
  model: `openclaw:${userId}`,
  messages: [{ role: 'user', content: '你好' }],
  stream: true,
})
for await (const chunk of stream) {
  const content = chunk.choices[0]?.delta?.content
  if (content) process.stdout.write(content)
}
```

---

## 错误处理建议

| 场景              | 前端行为                       |
| ----------------- | ------------------------------ |
| 4xx 错误          | 读取 `error.message` 展示给用户 |
| 5xx / 网关异常    | 提示"聊天服务异常，请稍后重试" |
| 网络异常          | 提示"网络异常，请检查网络连接" |
| 流式连接中断      | 提示"连接中断，请重试"         |
