// 崩溃报告接收规范（2026-10-26）
//
// 起因：分发的 Linux 用户把崩溃报回来了，但我们"不认识"——
// detail 只有 `…server.mjs:2314:28 <- at listOnTimeout` 这种 160 字截断行，env 与 diagnostics 全 null。
// 报回来了却没法开工，等于白报。下面这份是**验收标准**（代码在 `engine/crash-report-spec.mjs`）。
//
// 一句话原则：**宁可本地拦下来说"这份报告没用"，也不要发到对面当垃圾。**

## 一、报告必须包含什么

| 字段 | 为什么必须要 | 缺了会怎样 |
|---|---|---|
| `version` | 对回发布版本 | 不知道是哪一版 |
| `commit` | **行号会漂移，commit 是唯一可靠锚点** | 只能猜行号（这次就是） |
| `platform` / `arch` | 跨平台问题首先看这里 | 分不清是 Linux 特有还是通用 |
| `node` | 原生依赖/兼容问题常出在 node 版本 | 复现不了环境 |
| `uptimeSec` | 3 秒崩和 3 小时崩是两类问题 | 分不清"启动即炸"还是"跑久了漏" |
| `kind` | crash / restart / model-fail | 混在一起没法归并 |
| `signature` | 同类崩溃归并（抹掉地址/pid/时间） | 同一根因刷出 20 条 |
| `stack` | 至少 3 帧，越多越好 | 只能知道"某处炸了" |
| `exitCode` | `null` 表示被强杀/未捕获异常 | 分不清是崩溃还是被停 |

## 二、三档可定位性（本地先判，别让人工猜）

```
addressable  字段齐全 且 栈 ≥3 帧        → 直接开工
partial      有 commit/version + 栈 ≥1 帧 → 能缩小到模块，但可能还要问用户要日志
unusable     只够说"某处炸了"            → 本地就标记出来，不要当有效报告
```

收件箱每条都会带这个标记；`triageLine()` 输出一行结论，例如：

```
[addressable] crash · v2.129.3@f7be534c6 · linux/x64 · node v22.11.0 · 栈 3 帧 — 字段齐全且栈够长
```

## 三、版本支持窗口

`MIN_SUPPORTED_VERSION = 2.128.0`。低于它的报告标「低于支持窗口，先请对方升级」——
因为行号、模块结构早就变了，拿旧版栈去对当前代码是**假定位**。

> 发布新版本时如果改了模块结构，同步抬高 `MIN_SUPPORTED_VERSION`。

## 四、收到一条报告，怎么处理

1. **看标记**：`unusable` 的先补信息（让对方升级到最新版再报一次），别急着查。
2. **看 `commit`**：`git show <commit>` 回到那个构建，行号才对得上。
3. **看 `platform`/`node`**：Linux 特有就重点看路径分隔符、权限、`execFile` 的目标是否存在。
4. **看 `uptimeSec`**：3 秒内崩 → 启动阶段（初始化/定时器首次触发）；跑很久才崩 → 泄漏或累积状态。
5. **看 `watchdog 重启 N 次`**：说明是反复崩，优先按"同一签名循环"处理（`engine/crash-policy.mjs` 已能识别）。
6. **修完**：在本仓库 `CHANGELOG` 记一条，并在收件箱把对应条目标 `done`。

## 五、生成端在哪

`engine/telemetry.mjs` → `collectIncidents()` 里调 `buildCrashReport()`，
`reportIncidents()` 的 payload 带 `env`（上表字段）+ `triage` 一行结论 + 多行栈。
自动上报只发这些结构化事实，不发 `crash.log` 全文（避免夹带工作区路径与内容）。

## 六、回信：两段式，按原路返回

**第一封（收到时，自动）**：engine/crash-triage.mjs 判定能不能对上号，生成「为什么没查到 + 要你补什么」。
**第二封（修好后，手动确认）**：resolutionReply() —— 必须给出三样东西才允许发：

1. 在哪个版本修的（version + commit）
2. 改了什么（一句话说清，不许空喊「修好了」）
3. 请你这样验证（可留空，但建议写）

拿不出「版本 + 改了什么」的时候，接口直接 400 拒绝——「修好了」是最容易说空话的一句话。

**按原路返回**：反馈条目带 replyTo（提交方给的地址）与 threadId。
engine/feedback-relay.mjs 做 best-effort 转发：有地址才发，发不出去只在本地记 relayError，
绝不因为回信失败而丢掉「我说过什么」——回信内容永远先落本地（engine/feedback.mjs 的 addReply）。

当 replyTo 为空（目前公网反馈端点没给这个字段），回信只保存在本地收件箱，界面标「仅本地」，可复制后手动发回。

### 接口

    POST /api/feedback/:id/reply
      { kind: 'triage', text: '…' }                  # 第一封：原文照发
      { kind: 'resolved', change: '…', verify: '…' }  # 第二封：服务端拼装（可带 version）
    → { ok, reply: { id, kind, text, relayed }, relay: { ok, error? } }

## 七、工单号：让两边认得出是同一件事

公网端点不一定能回信，但**工单号是我们自己造的**，能带、能引用、能人工对。

| 字段 | 生成方 | 用途 |
|---|---|---|
| installId | 本机首次提交时生成，落 记忆/运行时/反馈工单.json | 多份报告归到同一台设备 |
| ticketId | 每次提交一个（T-YYYYMMDD-NNNN） | 回信里原样引用，双方对号 |
| replyTo | 可选：提交方有可访问地址才填 | 真正自动回信的通道 |

自动上报（engine/telemetry.mjs）与前端面板（FeedbackPanel）都会带上；
回信正文末尾若带「（工单 T-… · 设备 xxxxxxxx）」就是从这里来的。
