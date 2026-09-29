# pi-web 架构状态快照（活文档）

> 模式借鉴 KickSide `.ai/architecture/current-state.md`：每次后端结构改动，**同步更新本文件**。
> 这是"当前是什么"，不是"设计成什么"。过时即失职。最后更新：2026-09-12 by 元枢

## 进程拓扑（谁在跑、怎么拉起）

| 组件 | 端口 | 守护方式 | 当前状态 |
|---|---|---|---|
| pi-web 主服务 `server.mjs` | 127.0.0.1:8787 | `pi-web-watchdog` 计划任务：Boot 触发 + **每 5 分钟重复触发**；watchdog v2.1 进程内监控 | ✅ |
| watchdog v2.1 | — | 锁文件 `.watchdog.lock` 防多实例；分级检查：新启动 60s 内 5s 快查 / 连续失败保持快查 / 稳态 30s | pid 见 watchdog.log |
| cloudflared 隧道 | → pi.example.com | `cloudflared-tunnel` 计划任务：Logon 触发 + **每 5 分钟重复触发**；`restart-tunnel.bat` 幂等版（在跑 skip，挂了才拉） | ✅ |
| novel-studio | 本地 8790 | 手动 | 按需 |

## 自愈链路（2026-08-26 加固）

```
进程被杀/崩溃
  └→ watchdog monitorLoop 检测端口不通 → startServer()
       ├→ 启动前 node --check 语法体检，不过则回滚 server.mjs.bak-*（跳过坏备份）
       ├→ 重启限频 10s/次防风暴；5 分钟内连续崩 3 次 → 强制回滚备份
       └→ 计划任务每 5 分钟兜底重触发（长驻进程被整树杀也能 ≤5min 复活）
隧道断
  └→ cloudflared-tunnel 任务 5 分钟重触发 → bat 幂等检查 → 只在挂时拉起
```

### 教训锚点
- 计划任务「仅开机触发」在只睡眠不重启的机器上是单点故障 → 长驻守护必须配周期触发器
- restart-tunnel.bat 里 find 必须写绝对路径 `%SystemRoot%\System32\find.exe`

## 会话存储

- 直接使用 pi 引擎会话文件：`~/.pi/agent/sessions/<encoded-cwd>/`
- 列表 API 分组：cwd=工作区 → workspace 组；其他 → terminal 组（📱 小语会话（终端）置顶）
- 会话级模型持久化：`session-model-keys.json`（重启/LRU 恢复）

## 引擎主次对（2026-09-06）

- 后台 `engine-pair.json`：`primary` / `secondary`（默认 pi 主驾、元枢兑底；先长元枢，外置搁下）
- `GET/POST /api/engine/pair`；`handleChat` 每轮 `resolveLead`
- 元枢主循环：`unifiedChat` + `yuanshu-loop`（调度器 abort/并行）；`run_code` 进主工具表
- 元枢再稳：空回合 3 次重试后兑底、截断 tool JSON 立刻停、bash/dsh_task 吃 abort
- dsh 主驾走 `handleDshChat`（headless 一轮），不是 unifiedChat 套皮
- 媒体密文通道（2026-09-06）：`detectMediaIntents` 认视频；`generate_video` / `generate_image` / `generate_tts` / `list_channels` 宿主代持密钥；翻 auth.json 改提示下一步，不再死拒
- Agnes 2.5 创建体由 `videoCreateBody` 补 `mode=text`（keyframe/reference 按素材推断）；轮询带 `model_name`；创建 400 由 `repairVideoRequest` 补字段再试一次
- 元枢常驻 `YUANSHU_PROTOCOL` + 仓库根 `skills/` 索引（不再扫空的 `engine/skills`）；工具失败经 `coachToolFailure` 纠偏，禁止 bash 探 API
- `leadNote` 非原生通道写「该通道走自制循环」，不再说「适配器未就绪」
- 元枢治理层（2026-09-06，对照 Claude/OpenHands/OpenCode）：`todo_write` 清单、`delegate_task` 子代理、OpenHands 式卡住检测、任务匹配技能预点名、循环中段压缩、Auto 走 `routeForAuto`
- 对话内嵌视频播放器：正文/交付行/工具输出里的 mp4 路径收成 `/api/ws/file`；协议讲能力和汇报，不写死播放方式。pi 首轮就有 `generate_video` 等宿主工具
- 刷视频修复（2026-09-07）：消息含「剧本」时宿主不旁路出片（避免叠 `generate_video`）；`HEAD /api/ws/file` 回头不灌 body；前端按 path 去重播放器（忽略 sig）
- 元枢会话连续性（2026-09-06）：用户原话先落盘，打断也留痕；有历史就注明不是新开。创作先判断，搜两轮锁不到就动手
- 元枢评测绳（2026-09-06）：`runYuanshuEval` 冻结用例出 `passed/total/score`；`GET /api/engine/pair` 带 `eval`；不跑真模型，不证明出片/联网
- AIBody 系统协调（2026-09-12）：`aibody-runtime` 贯穿主聊天的规划、工具、子智能体、记忆、产物和治理观察；`aibody-runtime.json` 持久化有限运行记录，重启中的任务标为 `interrupted`。`subagent-traces` 记录父任务/会话关联、角色、状态和证据；不保存原始上下文或隐藏推理。`/api/aibody/overview` 与 `/api/subagent/history` 是全局只读观察入口，改动验收页不再承担唯一展示职责。
- 元枢情绪（2026-09-06）：`beginYuanshuEmotion` / `endYuanshuEmotion` 挂进 `handleUnifiedChat`；同一句 10 秒内不重复加 VAD（pi 兑底再进一次也不叠）
- 元枢 vs pi 横评（2026-09-06）：同一 `/api/chat` + deepseek-v4-flash；现网 9/10 平手，元枢均时更短；契约绳 2026-09-07 为 23/23（含磁盘工作记忆 plan_files）。不够切默认主驾。脚本 `bench/engine-bench.mjs`

## 模型路由

- 默认下拉 ⚡Auto：规则分类器按复杂度选 flash/pro；SSE 播报决策
- 免费降级链：商汤 flash-lite → 小米 mimo-v2.5 → NVIDIA llama-3.1-8b → 火山 ark-code
- 429/401/402/403 冷却机制（启动预探测 + 运行时降级）
- ⚠️ 已知问题（2026-08-26 用户反馈）：小米模型曾丢失工作成果，顺位待调
- 工坊智能填充（2026-09-07）：`directChat` 关思考（`thinking: { type: "disabled" }`），技能只塞精要（≤1800 字），模型预算 12s，超时走规则扩写。前端 30s 超时是第二道闸，不再当主因
- 视频规则扩写（2026-09-07）：`workshop-video-fallback.mjs` 必须写出人/衣服/动作/地点/【物理】；对白走过大肩正反打。禁止把用户原句贴进万能四拍（「里最清楚的那一拍」）
- 镜头卡格子要活（2026-09-07）：`composeVideoShot` / `composeImageShot` 按地点现写光影。点急推不再把山道写成硬顶光；绘图光影/风格可打字，填充不再白名单
- 视频脚本织入（2026-09-07）：`composeVideoScript` 把时间轴/物理/记忆点按当前动作重写。遁入夜色不再套地铁对镜头、硬顶光、帽檐

## 待办（后端线，来自 KickSide 对标）

1. **引擎托管升级流水线（watchdog v3 设计稿）**——见下节
2. IM 远程审批闭环可行性评估（对标 KickSide IM Bridge 审批卡片）
3. 健康检查可观测性：把 monitorLoop 的状态投影到 `/api/stats`

---

## 引擎托管升级流水线（watchdog v3 设计稿 · 未实现）

> 对标 KickSide DSH 安装管理器。目标：pi/dsh 引擎升级从"手动 npm -g"变成安全自动。

```
检测（每 6h 或手动）
  └→ npm view <pkg> dist.integrity + version（冻结本次精确目标，前端不可传包名/版本）
staging
  └→ 下载解包到私有 staging 目录；现有引擎继续服务不受影响
校验
  ├→ SemVer + sha512 integrity 精确匹配
  ├→ 入口文件 canonicalize 后必须仍在私有安装根内（符号链接/junction 越界 = fail closed）
原子激活
  ├─ current → backup（保留）
  ├─ staging → current
  └─ 重启引擎实例（复用现有 startServer 流程）
验证
  └─ 真实 HTTP 探活 + 页面身份标记（类比 __DSH_BOOT__）通过才算成功
回滚
  └─ 验证失败：删失败目录（删不动就隔离），恢复 backup，重启旧版
```

**落地前置**：pi 引擎装在哪、版本号从哪读、npm 全局目录写权限确认。先出 POC 只管 dsh（风险低），pi 引擎后跟。
## 2026-09-06 主驾运行观测

第一批升级新增 `engine/run-observability.mjs` 作为运行领域模型：从持久化 run 与事件账本生成统一快照。`/api/run/overview` 供 Board 与 Engine 使用，旧 `/api/runs/*` 接口保持不变。
