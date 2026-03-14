# OpenClaw 轻量多租户接入方案

版本：v1.0
目标读者：产品经理、后端工程师、前端工程师、运维
方案类型：PRD + 技术方案
适用范围：已有 App 内嵌聊天页，通过 Node.js 后端接入本地 OpenClaw Gateway，为每个用户提供独立 agent 和记忆空间

⸻

1. 项目背景

我们已部署 OpenClaw 服务器，并希望把 OpenClaw 聊天能力集成到自有 App 中，采用前端聊天页 + Node.js 后端代理的方式接入。前端不直接访问 OpenClaw Gateway，也不持有 Gateway token；后端负责为每个用户初始化独立 agentId 和 workspace，并将前端的聊天请求按 OpenAI 兼容格式转发给本地 OpenClaw POST /v1/chat/completions 接口。OpenClaw 官方文档说明，多 agent 模式下每个 agent 都有独立 workspace、独立 agentDir、独立 session store；Gateway 的 OpenAI 兼容接口也支持通过 model: "openclaw:<agentId>" 指定目标 agent。 ￼

⸻

2. 产品目标

2.1 业务目标

为 App 用户提供“开箱即用”的 AI 聊天能力，并满足以下目标：
	1.	每个用户拥有独立 agent
	2.	每个用户拥有独立 workspace / memory / session
	3.	前端只调用自家后端，不暴露 OpenClaw token
	4.	前端接入简单，只需两个接口
	5.	不引入数据库，使用配置文件 + 目录结构完成最小实现

2.2 非目标

本期不做真正意义上的强多租户隔离，不做复杂后台管理平台，不做租户配额与计费，不做 Control UI 嵌入，不做多渠道 bindings 路由，也不做复杂工具权限控制。需要特别说明的是，OpenClaw 官方安全文档明确指出：一个共享 Gateway 默认不是为互不信任或对抗型用户提供安全隔离边界而设计的；推荐的安全姿势是“一个 trust boundary 对应一个 gateway”，必要时进一步拆到独立 OS 用户或主机。当前方案适用于“轻量隔离”和“小规模可信环境”，不适合直接作为公有 SaaS 的强租户边界。 ￼

⸻

3. 用户故事

3.1 首次使用

作为一个 App 用户，我首次打开聊天页面时，系统会自动为我初始化一个专属 agent 和独立 workspace。初始化成功后，我即可开始聊天。

3.2 再次使用

作为一个 App 用户，我再次打开聊天页面时，系统会识别我已有的 agent 和 workspace，不重复创建，直接进入聊天。

3.3 隔离体验

作为一个 App 用户，我的聊天上下文、记忆、工作区文件不会和其他用户混在一起。

⸻

4. 方案总览

4.1 架构概述

App 前端聊天页
   │
   ├─ POST /api/openclaw/init
   │      body: { userId }
   │
   └─ POST /api/openclaw/chat
          body: { userId, messages, ...OpenAI兼容字段 }

Node.js 后端
   │
   ├─ 读取 / 修改 OpenClaw agents 配置
   ├─ 创建用户隔离 workspace 目录
   ├─ 维护 userId -> agentId（本期直接等于 userId）
   └─ 转发请求到本地 OpenClaw Gateway
          POST http://127.0.0.1:18789/v1/chat/completions

OpenClaw Gateway
   ├─ 多 agent
   ├─ 每个 agent 独立 workspace
   ├─ 每个 agent 独立 sessions / memory
   └─ model: "openclaw:<agentId>"

OpenClaw Gateway 是统一的运行入口，负责 agent 运行、路由、sessions、memory 等；其 HTTP 端点与 WS 控制面复用同一端口。官方文档明确说明 POST /v1/chat/completions 与 Gateway 正常 agent run 走同一执行路径，因此路由、权限和配置会遵循当前 Gateway 配置。 ￼

⸻

5. 核心设计原则

5.1 后端持 token，前端永不持 token

所有对 OpenClaw 的调用都由后端发起。OpenClaw 安全文档将可调用 HTTP API 的 bearer token 视为高权限 operator secret，因此禁止下发前端。 ￼

5.2 userId 直接映射 agentId

本期无数据库，采用最简单映射：
agentId = normalize(userId)

5.3 配置驱动

OpenClaw 当前公开文档中的多 agent 仍以配置驱动为主，支持 agents.list 配置、$include 拆分和热加载；因此本方案不尝试依赖不存在的“动态租户 API”，而是由后端生成 agents.json5。 ￼

5.4 主配置稳定，动态内容独立文件

主配置只保留网关基础配置；动态 agent 放到 generated/agents.json5。OpenClaw 配置支持 $include，适合这种拆分方式。 ￼

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
  },

  agents: { $include: "./generated/agents.json5" }
}

文档显示：Gateway 默认支持配置热加载，默认模式就是 gateway.reload.mode="hybrid"；OpenAI 兼容接口 POST /v1/chat/completions 默认是关闭的，需要显式启用。Gateway 默认建议运行在 loopback，本地访问再通过 SSH / tailnet / 反代方式接入远端。 ￼

6.2 动态 agent 配置

路径建议：~/.openclaw/generated/agents.json5

{
  list: [
    {
      id: "10001",
      workspace: "/srv/openclaw-tenants/10001/workspace"
    },
    {
      id: "10002",
      workspace: "/srv/openclaw-tenants/10002/workspace"
    }
  ]
}

OpenClaw 官方多 agent 文档说明，每个 agent 有独立 workspace，并且拥有单独的 agentDir 与 session store，位于 ~/.openclaw/agents/<agentId> 下。 ￼

⸻

7. 目录规划

建议将业务侧用户 workspace 放在独立目录树中：

/srv/openclaw-tenants/
  ├─ 10001/
  │   └─ workspace/
  ├─ 10002/
  │   └─ workspace/
  └─ ...

OpenClaw 的 workspace 是 agent 的工作目录和默认 home。memory 也与 agent 目录紧密相关：官方文档显示每个 agent 在 ~/.openclaw/agents/<agentId>/qmd/ 下拥有自包含的 QMD home，用于 memory 索引、cache 和 sqlite。也就是说，按 agent 拆分本身就能形成天然的独立记忆空间。 ￼

⸻

8. 产品流程

8.1 首次进入聊天页
	1.	前端加载聊天页
	2.	前端调用 POST /api/openclaw/init
	3.	后端检查 generated/agents.json5 中是否存在 agentId=userId
	4.	若不存在：
	•	创建 workspace 目录
	•	追加 agent 配置
	•	原子写回 agents.json5
	•	触发配置 reload
	5.	后端返回成功
	6.	前端收到成功后，调用 POST /api/openclaw/chat
	7.	后端转发到本地 OpenClaw /v1/chat/completions

8.2 非首次进入
	1.	前端调用 init
	2.	后端发现 agent 已存在
	3.	直接返回成功
	4.	前端开始聊天

⸻

9. 接口设计

9.1 初始化接口

路径

POST /api/openclaw/init

请求参数

{
  "userId": "10001"
}

业务规则
	•	userId 必填
	•	后端将 userId 规范化为 agentId
	•	若 agents.json5 中不存在该 agentId，则创建
	•	若已存在，则直接返回成功
	•	前端必须等待成功响应后才能调用聊天接口

返回示例：首次创建

{
  "ok": true,
  "agentId": "10001",
  "workspace": "/srv/openclaw-tenants/10001/workspace",
  "created": true
}

返回示例：已存在

{
  "ok": true,
  "agentId": "10001",
  "workspace": "/srv/openclaw-tenants/10001/workspace",
  "created": false
}

状态码
	•	200 初始化成功
	•	400 参数不合法
	•	409 当前配置文件被锁定或正在更新
	•	500 创建目录或写配置失败

⸻

9.2 聊天接口

路径

POST /api/openclaw/chat

请求格式

兼容 OpenAI Chat Completions，但额外要求带 userId：

{
  "userId": "10001",
  "messages": [
    { "role": "user", "content": "你好" }
  ],
  "stream": false,
  "temperature": 0.7
}

后端逻辑
	•	校验 userId
	•	将 agentId = normalize(userId)
	•	强制覆盖 model = "openclaw:<agentId>"
	•	透传 messages、stream、temperature 等字段
	•	调用本地 OpenClaw POST /v1/chat/completions
	•	将响应返回给前端

OpenClaw 官方文档说明，POST /v1/chat/completions 为 OpenAI 兼容端点，且底层会作为正常 Gateway agent run 执行；因此通过 model: "openclaw:<agentId>" 指向某个 agent 是符合官方能力边界的。 ￼

返回

直接返回 OpenClaw 的 chat completions 响应体。

状态码
	•	200 成功
	•	400 参数错误
	•	404 agent 不存在
	•	502 OpenClaw 转发失败
	•	500 后端内部错误

⸻

10. 时序图

10.1 初始化 + 聊天

前端              Node后端                     OpenClaw
 |                   |                            |
 |-- init(userId) -->|                            |
 |                   |-- 读agents.json5 --------->|
 |                   |<----- 本地文件读取 --------|
 |                   |-- 若无则创建目录 ----------|
 |                   |-- 写agents.json5 ---------|
 |                   |-- 触发reload -------------|
 |<-- init ok -------|                            |
 |-- chat ---------->|                            |
 |                   |-- POST /v1/chat/completions |
 |                   |   model=openclaw:<agentId> |
 |                   |--------------------------->|
 |                   |<--------- chat result -----|
 |<-- chat result ---|                            |


⸻

11. 后端实现方案

11.1 技术选型
	•	Node.js 20+
	•	Express 或 Fastify
	•	json5 用于读写 OpenClaw 配置
	•	fs/promises 做文件与目录管理
	•	fetch / undici 进行 HTTP 转发

11.2 核心模块划分
	•	agent-service：负责检查和创建 agent
	•	config-service：负责读取、更新、原子写入 agents.json5
	•	workspace-service：负责创建用户隔离目录
	•	chat-proxy-service：负责转发 OpenClaw chat 请求
	•	lock-service：负责进程内写配置串行化

11.3 关键约束
	1.	本期不使用数据库，因此 agents.json5 是系统唯一动态注册表
	2.	只允许一个服务实例负责写配置
	3.	配置写入必须原子化，避免 OpenClaw 热加载读到半截文件
	4.	必须做 userId -> agentId 规范化和白名单过滤

⸻

12. agentId 规范

为了避免路径穿越和配置污染，userId 不可直接原样写入配置和目录路径。
建议规则：
	•	仅允许字母、数字、下划线、横杠
	•	长度 1–64
	•	其他字符统一替换为 _

示例：

agentId = normalize(userId)
normalize("u-10001") => "u-10001"
normalize("abc/../x") => "abc____x"


⸻

13. 配置更新策略

13.1 原子写入

写配置采用以下流程：
	1.	读取 agents.json5
	2.	解析 JSON5
	3.	检查 agentId 是否存在
	4.	追加新 agent
	5.	写入 agents.json5.tmp
	6.	rename 覆盖正式文件

这样可避免 OpenClaw 在 watch 配置时读取到损坏文件。OpenClaw 配置参考页说明其配置有严格 schema 校验。 ￼

13.2 reload 策略

OpenClaw Gateway 文档指出其会 watch 活动配置文件路径，并且默认 reload 模式是 hybrid。对于本方案，agents 类变更一般可热应用。为了更稳妥地触发 include 文件更新生效，工程上建议在写完 generated/agents.json5 后，再 touch 一次主配置 openclaw.json。这是工程增强措施，目的是确保主配置 watch 链路稳定感知变更。 ￼

⸻

14. 前端接入说明

14.1 页面初始化

页面加载后立即执行：
	1.	调 POST /api/openclaw/init
	2.	等待返回 ok=true
	3.	再启用发送框和消息加载逻辑

14.2 发送消息

前端不传 model，只传：
	•	userId
	•	messages
	•	stream
	•	其他 OpenAI 兼容字段

后端强制决定使用哪个 agentId。

14.3 前端错误提示
	•	init 失败：提示“聊天服务初始化失败，请重试”
	•	chat 失败：提示“聊天服务异常，请稍后重试”
	•	agent 不存在：自动重新调用 init 一次

⸻

15. 安全与风险

15.1 已覆盖的安全点
	•	token 不下发前端
	•	Gateway 运行在 loopback
	•	后端强制覆盖 model
	•	agentId 来源受控
	•	每个用户独立 workspace / sessions / memory

15.2 未覆盖的边界

OpenClaw 官方文档明确说明，一个共享 Gateway 不是互不信任用户之间的安全边界。如果多个不可信用户可访问同一 tool-enabled agent，需要把他们视作共享该 agent 的 delegated tool authority；若要求 adversarial-user isolation，需拆分为多个 gateway，最好进一步拆到独立 OS 用户或主机。当前方案因此只适合轻多租户 / 弱隔离。 ￼

15.3 风险清单
	1.	agents.json5 随用户增长不断膨胀
	2.	多实例并发写配置会冲突
	3.	workspace 不是强沙箱
	4.	单 Gateway 下仍存在共享运行边界
	5.	无数据库意味着无法方便审计和统计

⸻

16. 监控与运维建议

16.1 建议观测项
	•	init 接口成功率
	•	chat 接口成功率
	•	OpenClaw /v1/chat/completions 响应时间
	•	agents.json5 当前 agent 数量
	•	workspace 目录总量
	•	reload 失败日志数

16.2 运维建议
	•	Node 后端与 OpenClaw 部署在同一主机
	•	OpenClaw 仅监听 loopback
	•	通过 systemd / pm2 托管 Node 服务
	•	定期备份 ~/.openclaw 与 /srv/openclaw-tenants

⸻

17. 版本里程碑

M1：最小可用版
	•	主配置固定
	•	generated/agents.json5
	•	POST /api/openclaw/init
	•	POST /api/openclaw/chat
	•	前端聊天页可用

M2：稳定性增强
	•	文件锁 / 进程锁
	•	配置 schema 校验
	•	重试与熔断
	•	streaming 支持

M3：租户增强版
	•	一租户一 Gateway
	•	配额管理
	•	审计日志
	•	后台管理页

⸻

18. 验收标准

产品验收
	•	用户首次进入聊天页能自动初始化并成功聊天
	•	再次进入时不重复创建 agent
	•	不同用户聊天上下文互不串线
	•	前端不暴露 OpenClaw token

技术验收
	•	agents.json5 能自动新增 agent
	•	workspace 目录能按用户创建
	•	POST /api/openclaw/chat 能成功代理到 model=openclaw:<agentId>
	•	OpenClaw 配置变更后无需人工重启即可生效，或可通过 touch 主配置稳定触发 reload
	•	失败场景有明确错误返回

⸻

19. 一句话结论

这套方案本质上是：

“单 Gateway、多 agent、Node 后端代理、前端双接口接入的轻量多用户 OpenClaw 集成方案。”

它充分利用了 OpenClaw 现有的多 agent、独立 workspace / memory、OpenAI 兼容 HTTP 接口和配置热加载能力，适合快速把 OpenClaw 嵌入你们现有 App；但它不是强安全多租户方案，若未来面向大量互不信任用户，需升级为“一租户一 Gateway”甚至更强隔离。 ￼
