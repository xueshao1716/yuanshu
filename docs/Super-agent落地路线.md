// ===== Super-agent 落地：缺口与路线（2026-11-07）=====
//
// 来源：DeepSeek《Super-agent 设计探索》（2026-11 公众号）。
// 这份文档只回答两个问题：我们现在缺什么、按什么顺序补，两天能出什么。

## 一、原文的五个模块（一句话版）

| 模块 | 一句话 |
|---|---|
| 双层架构 | 常驻 Router 只分派、多个隔离 Worker 干活 |
| 事件驱动 | Trigger → 两级过滤（代码 Fast Path + 模型 Slow Path）→ 订阅直通 |
| 上下文组织 | Inline & Spill + 链式召回（对象带 ID，按需逐跳展开） |
| 面向人的交互 | 异步 ReAct（start/stop，结果作为新事件投递）+ 按信道定制 |
| 存算分离 + Watchdog | 计算上云、状态入库、端侧无状态 daemon；外挂 Watchdog Session |

## 二、元枢现状对照

| 模块 | 现状 | 差在哪 |
|---|---|---|
| 双层架构 | `engine/subagent*.mjs`、`team-*.mjs`、`delegate.mjs` | **都是单会话内的工具**，不是常驻 Router + 隔离 Worker；主会话仍亲自干活 |
| 事件驱动 | `time-engine`（定时）、`wechat` 通道、任务板 | **没有 Thread 概念、没有订阅直通**；所有事件进同一个会话 |
| 两级过滤 | 无 | 每条事件都进模型判断，噪音成本高 |
| Inline & Spill | `compaction` / `context-budget` | 是"超了压缩"，不是"按局部性内联 + 溢出留引用" |
| 链式召回 | `memory/recall.mjs`（按相关性打分） | **没有对象引用图**（Trigger/Thread/Worker 互相带 ID） |
| 异步 ReAct | `job-pool` / `detached-run` / `run-manager` | 有后台任务，但**主对话仍是同步等待** |
| Watchdog | `lib/watchdog-limits.cjs` + `engine/watchdog-drift.mjs` | 有进程级 + 漂移判定（空转/连续失败/只写不交付），**没有"任务是否在推进"的定期巡检与介入** |

## 三、开工顺序（按"两天见效果"排）

### 第 1 天上午：订阅直通（已开工）

`engine/thread-router.mjs` —— 纯逻辑，已单测全绿：

```
threadKeyOf(event)      事件 → 话题键（wechat:群ID / task:任务ID / run:运行ID / mail:串ID）
subscribe / unsubscribe  登记与退订（多对多）
route(event)             有订阅 → { route:'direct', targets }；没订阅 → { route:'main' }
```

**下一步接线**（半天）：
1. 服务端收到事件时先 `route()`：
   - `direct` → 直接把事件投给目标 worker 会话（不经过主会话）
   - `main` → 走现有路径，并在派活后 `subscribe()` 登记
2. 微信入口（`engine/wechat/`）先接：同一个群的消息进它自己的会话
3. 任务板接：同一个任务 ID 的后续事件直通

**验收**：一边在群里聊，一边让主会话干活，互不打断；`/api/threads` 能看到订阅表。

### 第 1 天下午：Watchdog 巡检（接已有能力）

已有 `watchdog-drift.mjs`（判空转/连续失败/只写不交付）和 `run-manager`（stale 自愈）。
补一件事：**定时巡检 running 任务是否在推进**，卡住就记台账 + 通知。

```
每 5 分钟：
  for 每个 running 任务：
    lastEventAt 超过 10 分钟 且 没有新工具调用 → 标 stalled
    stalled 连续两轮 → 通知人（不自动杀，避免误伤长任务）
```

### 第 2 天：两级过滤 + 信道规范

1. **程序层 Fast Path**：白名单/前缀/静音规则，命中直接丢弃或直接记录，不进模型
2. **语义层 Slow Path**：剩下的才进模型判断
3. **信道规范**：IM 回复限长（原文验证 ≤100 词），GitHub/邮件走结构化

## 四、暂时不做的（明确写下，避免反复纠结）

| 项 | 为什么不做 |
|---|---|
| 计算上云 + 端侧 daemon | 需要服务器与凭据管理，投入产出比在"个人自用"阶段太低 |
| 完整 Router/Worker 重写 | 现有会话模型动一下就牵全身；先用订阅直通解决"被打断"这个真痛点 |
| 链式召回（完整版） | 先用 memory/recall + 显式 ID 字段，等对象多了再上引用图 |
| 异步 ReAct 全量改造 | 已有 job-pool；等"订阅直通"稳定后再改主循环 |

## 五、判断标准

每一步只认一个标准：**用户的哪个真实痛点被解决了**。

- 订阅直通 → "干活时被别的消息打断"（你提过）
- Watchdog 巡检 → "任务卡住了没人知道，看着像在跑"
- 两级过滤 → "什么消息都进模型，费 token 又慢"

---

## 六、落地记录（2026-11-07）

### 已落地

| 项 | 落在哪 | 怎么做的 |
|---|---|---|
| 订阅直通（接线） | `engine/thread-delivery.mjs`、`engine/thread-inbox.mjs`、`server.mjs` 的 `routerOnEvent` | 判定 direct 就不进主会话，事件落话题收件箱；派活时 `subscribe(threadKey, { workerId })` |
| 合并消费（批处理） | 时间引擎 runner | 任务 label 带话题键（`路由派活·<threadKey>`），开跑时 `takePendingBlock()` 把积压合并成一条 user 消息注入 |
| 收尾 | `onTaskFinished` | 终态退订；被停 → 撤销授权，正常结束 → 结单 |
| 工单级授权 | `engine/mandate.mjs` | 派活即开一张授权：范围取自「自主执行」策略、期限 24h、依据 explicit；`publish/merge/spend/persona/constitution/tunnel` 永远要人 |
| Watchdog 介入 | `engine/drift-escalation.mjs` + 10 分钟巡检 | 同类问题 4 小时冷却，且必须花主动预算（日 3 次）；**只提醒、不杀任务** |
| 可观测 | `GET /api/threads`、`GET /api/mandates` | 谁订了哪条话题、各话题积压多少；当前有效授权与全部记录 |

### 一处设计修正（与原文不同，是故意的）

原文的 Fast Path 是「把事件直投运行中的 Worker」。元枢没有可 steer 的常驻 run——派活是「定时任务 → unifiedChat」，
所以直通落成 **进收件箱 + 下一轮合并**（原文 §2.1 的 batching 那一半），而不是实时插话。
好处：不动执行层。代价：时效上限 = 该话题下一次任务的调度间隔。

### 对照表的两处勘误

- 「两级过滤：无」→ 已有：`engine/router.mjs`（2026-11-01），但**只挂在 `POST /api/inbound/event`**；
  微信走 `/api/chat`、邮件桥只 `recvEvent`，都还没过路由器。
- 「订阅直通：已开工（仅逻辑）」→ 自 2026-11-07 起已接线，`/api/threads` 可验。

