# OpenClaw 轻量多租户接入方案

版本：v2.0
目标读者：产品经理、后端工程师、前端工程师、运维
方案类型：PRD + 技术方案
适用范围：已有 App 内嵌聊天页，通过 Node.js 后端接入本地 OpenClaw Gateway，为每个用户提供独立 agent 和记忆空间

⸻

1. 项目背景

我们已部署 OpenClaw 服务器，并希望把 OpenClaw 聊天能力集成到自有 App 中，采用前端聊天页 + Node.js 后端代理的方式接入。前端不直接访问 OpenClaw Gateway，也不持有 Gateway token；后端负责将前端的聊天请求透传给本地 OpenClaw POST /v1/chat/completions 接口。OpenClaw Gateway 的 OpenAI Chat Completions 接口在收到请求时会自动创建 agent 和 workspace 目录，无需手动初始化。Gateway 的 OpenAI 兼容接口支持通过 model: "openclaw:<userId>" 指定目标 agent，并通过 user 字段保持稳定会话。

⸻

2. 产品目标

2.1 业务目标

为 App 用户提供"开箱即用"的 AI 聊天能力，并满足以下目标：
	1.	每个用户拥有独立 agent
	2.	每个用户拥有独立 workspace / memory / session
	3.	前端只调用自家后端，不暴露 OpenClaw token
	4.	前端接入简单，只需一个接口
	5.	不引入数据库，不管理配置文件，OpenClaw 自动管理 agent 生命周期

2.2 非目标

本期不做真正意义上的强多租户隔离，不做复杂后台管理平台，不做租户配额与计费，不做 Control UI 嵌入，不做多渠道 bindings 路由，也不做复杂工具权限控制。需要特别说明的是，OpenClaw 官方安全文档明确指出：一个共享 Gateway 默认不是为互不信任或对抗型用户提供安全隔离边界而设计的；推荐的安全姿势是"一个 trust boundary 对应一个 gateway"，必要时进一步拆到独立 OS 用户或主机。当前方案适用于"轻量隔离"和"小规模可信环境"，不适合直接作为公有 SaaS 的强租户边界。

⸻

3. 用户故事

3.1 首次使用

作为一个 App 用户，我首次发送消息时，OpenClaw 自动为我创建专属 agent 和独立 workspace，我无需等待任何初始化流程即可开始聊天。

3.2 再次使用

作为一个 App 用户，我再次发消息时，系统通过 user 字段自动路由到已有会话，继续之前的聊天上下文。

3.3 隔离体验

作为一个 App 用户，我的聊天上下文、记忆、工作区文件不会和其他用户混在一起。

⸻

4. 方案总览

4.1 架构概述

App 前端聊天页
   │
   └─ POST /v1/chat/completions
          body: { model: "openclaw:<userId>", messages, ...OpenAI兼容字段 }

Node.js 后端（纯透传代理）
   │
   ├─ 从 model 字段提取 userId
   ├─ 自动注入 user 字段以保持稳定会话
   └─ 转发请求到本地 OpenClaw Gateway
          POST http://127.0.0.1:18789/v1/chat/completions

OpenClaw Gateway
   ├─ 收到请求时自动创建 agent 和 workspace
   ├─ 每个 agent 独立 workspace
   ├─ 每个 agent 独立 sessions / memory
   └─ model: "openclaw:<userId>"

后端是纯透传代理，不读写任何配置文件，不管理任何目录，agent 的创建和生命周期完全由 OpenClaw Gateway 自动管理。

⸻

5. 核心设计原则

5.1 后端持 token，前端永不持 token

所有对 OpenClaw 的调用都由后端发起。OpenClaw 安全文档将可调用 HTTP API 的 bearer token 视为高权限 operator secret，因此禁止下发前端。

5.2 userId 通过 model 字段传入

前端发送请求时，将 userId 编码在 model 字段中：
model = "openclaw:<userId>"

后端从 model 字段提取 userId，并自动注入 user 字段，以确保同一用户的多次请求路由到相同会话。

⸻

6. OpenClaw 配置设计

6.1 主配置文件

路径建议：~/.openclaw/openclaw.json

{
  gateway: {
    port: 18789,
    bind: "loopback",
    auth: {
      token: "YOUR_GATEWAY_TOKEN"
    },
    reload: { mode: "hybrid", debounceMs: 300 }
  },

  http: {
    openai: { enabled: true }
  }
}

Gateway 默认支持配置热加载；OpenAI 兼容接口 POST /v1/chat/completions 默认是关闭的，需要显式启用。Gateway 默认建议运行在 loopback，本地访问再通过 SSH / tailnet / 反代方式接入远端。

无需额外的 agents 配置文件，OpenClaw 在收到请求时自动创建和管理 agent。

⸻

7. 目录规划

OpenClaw 自动管理 agent 相关目录。每个 agent 在 ~/.openclaw/agents/<agentId> 下拥有独立的 agentDir 和 session store，在 ~/.openclaw/agents/<agentId>/qmd/ 下拥有自包含的 QMD home，用于 memory 索引、cache 和 sqlite。workspace 目录也由 OpenClaw 自动创建（如 ~/.openclaw/workspace-001 等）。

后端无需创建或管理任何目录。

⸻

8. 产品流程

8.1 用户发送消息

	1.	前端加载聊天页
	2.	用户输入消息，前端调用 POST /v1/chat/completions
	3.	后端从 model 字段提取 userId，注入 user 字段
	4.	后端将请求透传到本地 OpenClaw Gateway
	5.	OpenClaw 自动创建 agent（如首次）或路由到已有 agent
	6.	OpenClaw 返回响应，后端透传给前端

整个流程无需初始化步骤，首次和非首次使用走同一路径。

⸻

9. 接口设计

9.1 聊天接口

路径

POST /v1/chat/completions

请求格式

完全兼容 OpenAI Chat Completions 格式：

{
  "model": "openclaw:10001",
  "messages": [
    { "role": "user", "content": "你好" }
  ],
  "stream": false,
  "temperature": 0.7
}

后端逻辑
	•	从 model 字段提取 userId（解析 "openclaw:<userId>" 格式）
	•	自动注入 user 字段（值为 userId），保持稳定会话
	•	透传 messages、stream、temperature 等所有 OpenAI 兼容字段
	•	调用本地 OpenClaw POST /v1/chat/completions
	•	将响应原样返回给前端

返回

直接返回 OpenClaw 的 chat completions 响应体。

状态码
	•	200 成功
	•	400 参数错误（如 model 格式不合法）
	•	502 OpenClaw 转发失败
	•	500 后端内部错误

⸻

10. 时序图

前端              Node后端                     OpenClaw
 |                   |                            |
 |-- chat ---------> |                            |
 |  model=openclaw:X |                            |
 |                   |-- 提取userId, 注入user --->|
 |                   |-- POST /v1/chat/completions |
 |                   |   model=openclaw:<userId>  |
 |                   |   user=<userId>            |
 |                   |--------------------------->|
 |                   |   (自动创建agent如首次)      |
 |                   |<--------- chat result -----|
 |<-- chat result ---|                            |


⸻

11. 后端实现方案

11.1 技术选型
	•	Node.js 20+
	•	Fastify
	•	fetch 进行 HTTP 转发

无需 json5、fs/promises 等文件操作相关依赖。

11.2 核心模块划分
	•	chat-proxy-service：负责转发 OpenClaw chat 请求，包括从 model 提取 userId、注入 user 字段、透传请求和响应

后端仅此一个核心模块，职责单一明确。

11.3 关键约束
	1.	后端是无状态的纯透传代理
	2.	后端不读写任何文件或配置
	3.	后端强制覆盖 user 字段，确保会话路由可控
	4.	后端不持有 agent 状态，完全依赖 OpenClaw 管理 agent 生命周期

⸻

12. 前端接入说明

12.1 发送消息

前端直接使用 OpenAI SDK 或兼容方式调用后端唯一接口：

POST /v1/chat/completions

请求中需要传入：
	•	model: "openclaw:<userId>"
	•	messages
	•	stream（可选）
	•	其他 OpenAI 兼容字段（可选）

完全兼容 OpenAI SDK，无需任何额外的初始化步骤。

12.2 前端错误提示
	•	chat 失败：提示"聊天服务异常，请稍后重试"
	•	参数错误：提示"请求格式错误"

⸻

13. 安全与风险

13.1 已覆盖的安全点
	•	token 不下发前端
	•	Gateway 运行在 loopback
	•	后端强制覆盖 user 字段
	•	userId 来源受控（从 model 字段提取）
	•	每个用户独立 workspace / sessions / memory

13.2 未覆盖的边界

OpenClaw 官方文档明确说明，一个共享 Gateway 不是互不信任用户之间的安全边界。如果多个不可信用户可访问同一 tool-enabled agent，需要把他们视作共享该 agent 的 delegated tool authority；若要求 adversarial-user isolation，需拆分为多个 gateway，最好进一步拆到独立 OS 用户或主机。当前方案因此只适合轻多租户 / 弱隔离。

13.3 风险清单
	1.	workspace 不是强沙箱
	2.	单 Gateway 下仍存在共享运行边界
	3.	无数据库意味着无法方便审计和统计

⸻

14. 监控与运维建议

14.1 建议观测项
	•	chat 接口成功率
	•	OpenClaw /v1/chat/completions 响应时间
	•	后端转发延迟

14.2 运维建议
	•	Node 后端与 OpenClaw 部署在同一主机
	•	OpenClaw 仅监听 loopback
	•	通过 systemd / pm2 托管 Node 服务
	•	定期备份 ~/.openclaw

⸻

15. 版本里程碑

M1：最小可用版
	•	主配置固定
	•	POST /v1/chat/completions（纯透传代理）
	•	前端聊天页可用
	•	OpenClaw 自动管理 agent 生命周期

M2：稳定性增强
	•	重试与熔断
	•	streaming 支持
	•	请求日志与监控

M3：租户增强版
	•	一租户一 Gateway
	•	配额管理
	•	审计日志
	•	后台管理页

⸻

16. 验收标准

产品验收
	•	用户首次发送消息即可成功聊天，无需等待初始化
	•	再次发消息时自动路由到已有会话
	•	不同用户聊天上下文互不串线
	•	前端不暴露 OpenClaw token

技术验收
	•	POST /v1/chat/completions 能成功代理到 OpenClaw
	•	后端从 model 提取 userId 并正确注入 user 字段
	•	OpenClaw 自动创建 agent 和 workspace，无需手动干预
	•	失败场景有明确错误返回

⸻

17. 一句话结论

这套方案本质上是：

"单 Gateway、自动 agent 管理、Node 后端纯透传、前端单接口接入的轻量多用户 OpenClaw 集成方案。"

它充分利用了 OpenClaw 的自动 agent 创建、独立 workspace / memory、OpenAI 兼容 HTTP 接口能力，后端零状态纯透传，前端完全兼容 OpenAI SDK，适合快速把 OpenClaw 嵌入现有 App；但它不是强安全多租户方案，若未来面向大量互不信任用户，需升级为"一租户一 Gateway"甚至更强隔离。
