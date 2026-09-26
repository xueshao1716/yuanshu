# 超维模式第一期 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 修复沙箱会话错配，并交付默认一小时的维护授权协议及真实不可用状态，绝不接入无限 shell。

**Architecture:** 从 server 提取可测试的沙箱/维护路由；授权生命周期为纯协议模块，无签发凭据、无生产激活入口。前端使用显式会话和分会话缓存；保留三个原有档位。

**Tech Stack:** Node ESM、node:test、React、TypeScript、SWR。没有新增运行依赖。

## Task 1：明确会话边界

Files: `engine/sandbox-api.mjs`, `server.mjs`, `tests/unit/sandbox-api.test.mjs`。

- [x] 先写测试：从临时目录创建 API，`get(undefined)` 返回 400；`get('missing')` 返回 404；`set({sessionId:'A',preset:'cautious'})` 不改变 B。`set({preset:'trusted'})` 不回退到 latest。
- [x] 运行 `node --test tests/unit/sandbox-api.test.mjs`，确认新增导出缺失/断言失败。
- [x] 实现 `createSandboxApi({agentDir,sessionExists})` 返回 `get(sessionId)` 和 `set(body)`，统一返回 `{status,body}`；输入只接受字符串、存在的会话。`set` 调用原 `recordSandboxMode`，来源固定为 api，而非人工证明。
- [x] 将 server 原两个 inline handler 换成模块调用；会话存在性使用 `activeSessions.has(sid) || !!findSession(sid)`。旧日志读取不迁移、不删除。
- [x] 运行新测试与原 sandbox-session / yuanshu-sandbox 测试，提交本组变更。

## Task 2：维护协议与关闭的生产入口

Files: `engine/maintenance-protocol.mjs`, `engine/maintenance-api.mjs`, `tests/unit/maintenance-protocol.test.mjs`, `tests/unit/maintenance-api.test.mjs`, `server.mjs`。

- [x] 先写测试：默认 `3600000`，最大 `7200000`；拒绝零/负/NaN/字符串/超长时限；校验 session/task/run/principal/executor/policy/epoch、动作摘要、时钟、期限和撤销版本。
- [x] 先写生命周期测试：requested 可拒绝/撤销，active 可到期/撤销/完成，终态不能复活；普通消息不能执行 grant；有效状态只是协议判断、不是签发授权。
- [x] 运行两份新测试，确认缺失行为失败。
- [x] 实现纯校验模块，导出默认常量、时限解析、状态计算和只收紧的终态转换。无签发函数、无 shell、无凭据读取、无自动续期。
- [x] 生产 `createMaintenanceApi({sessionExists})` 返回 status/request/revoke：status 明确 available=false、默认时限、不可用原因和空租约；request 即使伪造 human/lease 也返回 503 executor_unavailable；revoke 不虚报成功，未知租约返回 404。
- [x] 注册只读 status、申请和 revoke 路由，沿用 server 现有鉴权，无 grant/renew 路由。
- [x] 重跑本组测试。第一期状态机仅用于协议验收；真实签发、持久审计、进程撤销在隔离控制面交付前仍是上线阻断项。

## Task 3：沙箱面板与超维说明

Files: `frontend/src/api.ts`, `frontend/src/components/engine/SandboxModePanel.tsx`, `frontend/src/components/engine/MaintenanceModePanel.tsx`, `tests/unit/sandbox-ui-contract.test.mjs`。

- [x] 先用源码契约断言 sessionId 出现在 GET 与 POST、SWR key 带 sessionId、组件 keyed by sessionId、busy 时全部切换禁用、错误提示与超维不可用原因存在；运行确认失败。
- [x] `SandboxApi.get(sessionId)` 使用编码查询参数；`set(sessionId,preset,reason)` 显式提交，MaintenanceApi 只提供 status。
- [x] 外层从 useApp 取 currentSessionId，内层按 id 重挂载，异步消息加 unmount 守卫；无会话只显示选会话提示；请求失败不显示旧档可操作状态。
- [x] 增加超维状态区：默认 1 小时、最长 2 小时、待接入原因、范围限定、仅本机人工批准；禁用启用按钮，不伪造授予/撤销按钮。
- [x] 对旧日志显示“界面/API 记录”而非“人工已认证”。不重设计引擎页面。
- [x] 重跑契约测试、类型检查，按 Impeccable harden 检查边界状态。

## Task 4：验收与交付

- [x] `npm run verify` 隔离全量测试、类型检查、非线上目录构建；日志只写本 worktree/tmp。
- [x] 对两处 UI 运行 Impeccable detect；在隔离本地页面验证空会话、A/B 切换、加载失败、默认一小时、超维不可激活与窄屏布局。
- [x] `git diff --check`，核查范围；记录实际通过数与未完成边界，再提交。
- [x] 不覆盖主目录现有脏前端，不更改当前权限；完成分支验收后报告合并/部署状态，不能把“已实现第一期”描述为整机权限已开放。

## 起点证据

独立 worktree：`D:/pi-web/.worktrees/hyperdimensional-phase1`。原沙箱两个测试文件 20/20 通过。主仓库已有用户前端与 CHANGELOG 改动，本分支不包含它们。

## 2026-09-26 验收记录

- `npm run verify` 最终退出 0；单元测试 2285/2285，类型检查和隔离构建通过，证据状态为 `passed`，输入指纹保持一致。此前边修改边验证的一次运行不能作为最终成功证据，本次已稳定源码后重跑。
- 定向测试 28/28；`node --test tests/e2e/maintenance-ui.playwright.mjs` 2/2，覆盖 1440/390 宽度、空会话、A 保存时切 B、错误与重试、不可启用状态及无横向溢出。使用临时数据及真实组件，外网和线上后端均被阻断；不等于生产服务端 HTTP 全链路验收。
- `node --check server.mjs`、`git diff --check` 通过；两处组件 Impeccable detect 返回空数组。构建存在大于 500 kB 的 chunk 提醒，npm 存在既有 `allow-scripts` 配置提醒，不冒称零警告。
- 截图保存于 `tmp/maintenance-ui/maintenance-1440.png`、`maintenance-390.png`；本次图像查看工具不可用，未做人工视觉验收，布局结论仅来自浏览器断言。
- 验证日志：`tmp/verification-{unit,types,build}.log`；源码绑定证据：`tmp/review-verification.json`。这些临时产物不提交。
- 实施按依赖顺序完成后统一提交本期变更（未按每个 Task 分别提交）。保留 `feat/hyperdimensional-phase1`，不覆盖主目录用户改动；未合并、部署、重启、双推或打包，线上版本号不变。
- 第二/三期阻断项：可信原生批准与签名防重放、真正的操作系统隔离、受保护持久审计、进程撤销、发布与恢复。当前纯协议和禁用入口不能当作这些能力已完成。

## 后续合并与交接（2026-09-26）

用户随后批准覆盖正式目录；功能提交 `e2820806` 已快进合入 main，源码版本同步为 2.116.10，保留原有未提交界面工作。合并后 `npm run verify` 退出 0，2328/2328 单元测试、类型检查及隔离构建通过，证据状态按当前树重新读取为 passed；两视口组件测试 2/2、Impeccable detect 空数组。源码摘要 `3fdd60c3eaba995f35dde77abaa6ce63bbfeef4c94c06a8f1aaf4ea359c0091c`。

本轮线上健康，但仍有活动任务，实际服务版本为 2.116.8（PID 29400），因此未部署前端、重启、推送或打包。上文“未合并”是分支验收时的历史状态，已由本节替代。备份和激活步骤见 `docs/系统说明与接续-2026-09-26.md`；真实权限仍不可启用。
