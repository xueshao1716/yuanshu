# 天团验收链路：隔离 HTTP 联调补验

日期：2026-09-20。目录：`D:/pi-web/.worktrees/verification-20260920`。
本文件补充上一批 `2026-09-20-team-acceptance-validation.md`，不代表上线。

## 本轮变更

- 抽出 `engine/team-run-read.mjs`，正式 server 的 GET `/api/team/run` 委托同一处理器；测试不再另写一份快照读取逻辑，也无需启动带后台任务的完整业务服务。
- 修正原 GET 路由无上限整文件读取的问题：快照上限 16,000,000 字节，文件描述符上的有界读取；拒绝非普通文件、超限、损坏 JSON、非对象顶层和已有链接/硬链接。
- 读取错误统一返回提示，不回传 JSON 解析器可能携带的正文片段或内部路径。缺失快照仍返回空记录和独立启动状态。
- 提取 `engine/review-read.mjs` 供快照和验收核对复用。读取前在已打开的文件描述符上检查大小；读取字节数变化则拒绝。不是敌对并发写入下的完整 TOCTOU 防护，也不是完整快照字段 schema 校验。
- 核实 `WS_ROOT` 由 `path.resolve(CONFIG.cwd)` 注入：验收与天团读取指向同一工作区，不需要另改目录配置。

## 新增 14 项验证

`tests/unit/team-run-http.test.mjs` 使用临时工作区和系统分配的回环端口，调用真实 pending/history/team-read 处理器与 HTTP JSON 工具；不会启动 runner 或调用模型。

覆盖提交→待审→接受、拒绝不交付、重复接受 409、实际历史回滚→target_changed、目标冲突 409 且保留人工内容、损坏提议→unknown、缺失快照、五种无效快照、超限快照不走无界读取、硬链接拒绝，以及正式 server 接线契约。

测试后的临时工作区与监听器由测试清理。HTTP 测试不涵盖完整 server 的鉴权、全局路由分发、SSE、计划任务或真实模型输出；不将测试夹具的路由层等同于生产端到端。

## 证据

- TDD 红灯：缺少共用处理器/接线时 14 项失败，`tmp/p1-http-red.log`。
- 定向绿灯：14 项新增 + 22 项验收 + 4 项入口/UI 契约，40/40，`tmp/p1-http-focused.log`。
- 全量回归：1692/1692，50 suites，0 失败/跳过，约 101 秒，退出 0，`tmp/p1-http-full.log`。三个工作区环境变量均指向本轮独立临时目录。
- TypeScript 检查和 Vite 构建退出 0，`tmp/p1-http-build.log`。构建输出仅写 `tmp/p1-http-build-20260920`，index.html 实存 1280 字节，没有覆盖 frontend/dist/public。
- server 及三个相关后端模块语法检查通过；git diff --check 无错误，仅既有 CRLF 提醒；两个相关前端组件 Impeccable detect 返回 `[]`。本轮未改 UI，也未重跑浏览器检查。
- 构建仍有 Toast 混合导入和大于 500 kB 的分包警告；npm 仍提示 allow-scripts 配置，不在本轮扩展修复。

## 复审及上线边界

- 独立复审端再次明确返回“子任务内容为空，尚未执行检查或修改”。未把它记作通过，也没有无限重试。主执行者已检查本轮代码、接线以及 VIDEO/ARBIT_FINAL 与清单的字段一致性；这不替代独立审查。
- 仍为隔离候选：没有提交、合并、部署、重启在线 8787、调用付费模型、外发通知或更新记忆。
- 尚待完成：独立复审与部署前完整候选服务联调；后续统一 run-manager、取消/恢复、预算约束，以及视频/小说专项仍不在本次完成范围内。
