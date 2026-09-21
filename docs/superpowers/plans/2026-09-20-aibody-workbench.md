# 元枢 AIBody 与工作台升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以桌面 aibody 资料为参考，完善元枢工作台的真实运行、质量验收与交付闭环；先统一证据和流程含义，再分项接入创作能力。

**Architecture:** 保留现有 Node.js / React、run-store / run-manager、AIBody 观察层和提案审批机制。资料作为设计参考与模板来源，不整体运行外部 Python 系统，不新增平行的人格或任务引擎。本文包含总体路线，以及可独立验证的第一批“流程语义与交付判定契约”实施步骤；接线、迁移、视频、小说、技能分别制定独立实施计划。

**Tech Stack:** Node.js ESM、node:test、React、TypeScript、现有原子 JSON 存储与运行事件记录。

---

## 0. 本轮边界与当前状态

- 最初要求是“看完桌面 aibody 后再规划”；随后用户“可以，你弄”授权实施。现已推进第一批 P0 安全/草稿验收修正与独立流程契约，仍不合并、不部署、不重启 8787。实施证据见同目录 `2026-09-20-p0-validation.md`。
- 隔离目录：`D:/pi-web/.worktrees/verification-20260920`。下文相对路径均相对此根目录；不是正在提供服务的 `D:/pi-web` 主目录。
- 已有候选修复保留，不能当作已上线。工作区还包含本任务之前的其他改动与构建产物，实施前逐项核对来源，不整体覆盖或清理。
- 早先全量测试记录为 1573/1573；之后有局部修改，只运行过针对性检查。因此该数字不是当前全部候选改动的最终验收结果。
- 原候选 runner 的嵌入凭据、先交付后验收问题已在隔离副本修正；在线服务仍调用工作区外部 runner，未完成接线与上线核验。凭据值不写入计划、日志或报告；本轮没有轮换线上凭据。
- 本轮没有执行外部 Python 脚本、真实付费生成、外部通知或记忆更新。

## 1. 资料范围与可信度

原始资料根目录：`C:/Users/xuexiaofeng/Desktop/aibody`。

| 资料 | 本轮检查 | 可吸收内容 | 不能据此认定 |
|---|---|---|---|
| 多AI角色扮演系统V18.0第三.pdf（60页） | 全文文本提取、重点章节比对 | 快速/标准/深度模式、多视角核查 | 引用研究与效果数字已复现 |
| 多AI角色扮演系统V20.0_1784025496110_0_ixzh.docx | 段落与表格文本提取 | 最终成稿交付、角色责任 | 参考代码就是可运行系统 |
| 多AI角色扮演系统V25.0_融合版全量技术文档.docx | 段落与表格文本提取 | 专项创作、反馈流程 | 与 V20 同名步骤同义 |
| 多AI角色扮演系统V26.0_全量融合技术文档.pdf（49页） | 全文文本提取、关键算法比对 | 分层加载、任务选择、质量约束 | 全网协作与效率指标已验证 |
| 自适应提示词生成系统技术档案_2025融合版.pdf（21页） | 全文文本提取、预算算法检查 | 意图→约束→预览→定向修正→反馈 | 伪代码能直接调用真实生成服务 |
| Kimi_Agent_symbiosis系统融合.zip | 5 个 Python 文件静态阅读、AST 解析 | 规则优先级、版本、快照与回滚思路 | 仿真成功等于真实工具成功 |
| symbiosis_v5_5_complete.py | 静态阅读、AST 解析 | 有边界的反馈记录与技能调整 | 自主学习质量已被真实评测证明 |
| seedance_ultimate_v7_fusion_enhanced.py | 静态阅读、AST 解析 | 镜头、情绪、空间、角色一致性模板 | 已接通视频生成、价格实时有效 |
| SEEDANCE_V7_SUPREME_20260302_040103.md | 样例内容核查 | 可交付计划书结构 | 样例证明进化或生成能力有效 |

提取文本在 `tmp/aibody-review/`。DOCX 的 P 编号为提取段落编号，不是页码。PDF 解析出现一个错误对象指针警告；图片、公式或排版可能有提取损失。本轮未完成逐页视觉核验，不能声称全面视觉审校。AST 解析成功只说明语法可解析，不说明依赖、执行或业务正确。

## 2. 必须解决的定义冲突

1. **S8.5 不同义。** V20 P1584 起是“最终完善版本生成”；V25 P655–677 是“反馈迭代”。采用 `profileId + profileVersion + stageKey`，展示名称可沿用原文，但不能单凭 `S8.5` 判完成。已有候选界面的全局 V20 缺失警告需按 profile 改造。
2. **小说四重交付不同义。** V25 P989–1030 为大纲、章节、人物卡、完整小说；V26 第40页为世界观、人物设定、情节大纲、章节正文。保存规范化产物类型，再由 profile 声明必需项，不把两个列表静默混为一套。
3. **高压力上下文策略相反。** V26 第29页压力高触发更大规模 GASEOUS 加载，第32页却降到 L1。采用硬 token/费用/并发预算，压力升高时缩减活跃技能；L1 元数据→被选中 L2 指令→必要 L3 资源。质量升级不能突破预算。
4. **仿真不是执行。** ZIP 中 Tool.use 用 `np.random.random() < success_rate` 决定成功；网络路径还保留“实际实现中这里应该是HTTP/WebSocket请求”的说明。这些路径只可作为仿真研究，不用于工作台成功率或交付判断。
5. **预算不能照搬。** 自适应提示词资料第18–19页 reserve 已扣减，consume 成功又扣减并奖励。实际货币、token、虚拟风险额度须分账；预留、结算、释放均需唯一请求标识与幂等处理。
6. **文档版本不等于验证等级。** 配置组合数、时间线和效率提升数字存在解释缺口；暂不作为发布指标或选型结论。六维置信度与五维质量分分别定义，不合成无来源的“总智能分”。

## 3. 工作台产品结构：保留三个入口，补清楚职责

| 入口 | 用户需要看见 | 数据与边界 |
|---|---|---|
| 概览 | 正在做什么、卡在哪里、等待谁、产物在哪里、费用是否已结算 | 复用 run 事件与 AIBody 观察记录；无数据、读取失败、未验证分别显示 |
| 改动验收 | 改前改后、风险与检查证据、接受/拒绝、冲突、历史与回滚 | 提案绑定内容摘要；旧提案不覆盖新文件；审计失败不能报告成功 |
| 天团 | 工作流版本、实际参与角色、步骤记录、检查结果、草稿与正式交付 | 仅显示实际角色调用；任务结束不等于质量通过，更不等于用户已接受 |

不在首页增加抽象的“十五层、相变、全网涌现”等控制项。简单任务默认单角色，复杂任务才按需求和预算使用有界协作。

现有代码并非空白：`engine/aibody-runtime.mjs` 已记录真实事件并区分未观测状态，`engine/aibody-runtime-store.mjs` 会把重启时运行中的记录标为 interrupted。保留它们作为观察层；`engine/run-manager.mjs` 管执行。`engine/misc-api.mjs` 的静态文件存在性映射只说明组件存在，不等于能力已验证。

## 4. 实施路线与放行条件

### P0：先收紧现有候选修复，禁止直接发布

范围：`scripts/team-run-live.mjs`、`scripts/team-checklist.mjs`、`engine/review-file-safety.mjs`、`engine/pending-api.mjs`、`engine/history-api.mjs` 及相关回归测试。

- 移除所有嵌入凭据；统一从受控配置读取，扫描只报告位置与类别，不打印值。缺少配置应明确失败，不回退到默认秘密。
- 正式产物由批准环节发布；生成阶段只写任务专属暂存区。模型标题不能直接决定目录或任意文件路径。
- 补齐队列/审计路径链接逃逸、写入/审计失败一致性、并发接受、旧提案摘要冲突测试。
- 验收界面对构建生成文件与源码改动做区分，避免大量 hash 资源掩盖真正风险。
- 放行依据：临时目录中的真实文件断言、无凭据的静态扫描结果、失败注入检查。测试失败保持待验收，不自动批准。

### P1：统一工作流与真实运行记录

范围：现有 `engine/run-{store,manager,event-log,effects,api,observability}.mjs`，新增版本化 team contract；`frontend/src/components/TeamRunView.tsx`、`frontend/src/pages/Board.tsx`、`frontend/src/api.ts`；AIBody 观察层只接事件不发执行指令。

- 先实施本文第6节契约切片，再单独制定路由/状态迁移实施计划。
- 把目前由 `server.mjs` 启动仓库外 runner 的路径迁到仓库内、可注入配置的模块，迁移前后保留兼容读取。
- 新运行绑定 profile、版本、runId、clientRequestId、事件序号、检查点、产物摘要和检查来源；历史记录未知字段不猜测补齐。
- 区分执行状态、质量状态和交付状态。重启后核对不确定副作用，不盲目重放付费调用或文件发布。
- 重复请求不重复执行；刷新界面不启动任务；断线后按事件序号续读；取消能传播到模型/工具并保留检查点。
- 放行依据：同一临时任务经历正常、失败、取消、重启、重复请求后，三个工作台入口的状态一致。

### P2：视频与自适应提示词专项

复用 `engine/story-*` 的提示词、镜头、流程、存储与 provider adapter，不整体运行 Seedance Python 主程序。

- 把 12-Pillars 转成可追溯检查项，保留镜头/角色/空间约束；先交付脚本与镜头表，再声明是否具备真实视频生成能力。
- 选取 Seedance 的模板与约束数据，去掉随机质量分、随机最佳发布时间和未经核实的硬编码报价。
- 提示词流程：意图与必需条件→可编辑预览→成本与能力说明→已授权生成→有依据的检查→定向修正。
- 参数由实际 provider 能力声明驱动；不把一个平台的参数直接转交另一平台。缺少图像评测器就显示“未评测”。
- 放行依据：固定样例集的完整性/一致性检查、真实适配器契约测试、预算上限与失败扣费测试；付费端到端另行确认范围。

### P3：小说与技能专项，各自独立计划

- 小说复用 `engine/workshop-novel-run.mjs`：世界观、人物、情节大纲、章节、整书导出使用稳定产物类型；V25/V26 的要求由 profile 映射；检查人物状态、章节连续性与可下载文件。
- 技能复用现有技能装载与 `engine/skill-gene.mjs`：描述、输入输出、权限、版本、依赖、来源和测试样例齐全后才能试用。导入外部技能不默认授予执行权限或联网能力。
- 放行依据：缺任一必需产物不报完整交付；技能升级可回退到上版；不改变人格、身份与高风险权限。

### P4：有证据的改进与策略评测

- 复用 `engine/skill-gene.mjs`、`engine/evolution-api.mjs`，以真实用户反馈和执行证据生成可审阅提案。
- 每次变更保存基线、评测样例、版本与回滚点；成本、耗时、成功率有分母和观察窗口。
- 自适应选角色/模式先离线评测，再受控启用；不引入随机“成长分”作为运行事实，不自动修改人格和安全规则。

## 5. 共用验收矩阵

| 场景 | 必须满足 |
|---|---|
| 模型说完成，但无检查记录 | 任务可结束；质量仍未验证；不能正式交付 |
| 检查失败或解析不出结果 | 明确失败或未验证，不用默认 true 补齐 |
| 用户未验收 | 产物为草稿/待验收，不写入正式交付路径 |
| 验收后草稿被改动 | 摘要不符，要求重新验收 |
| 重复启动/回放事件 | 同一请求只执行一次，同一副作用不重复结算 |
| 服务重启或取消 | 显示中断/取消；已完成步骤保留；不确定步骤单列 |
| 网络失败/无权限/空记录 | 三种状态分别呈现，可重试但不重复创建任务 |
| 超预算 | 发出下一次调用前停止；保留已有草稿与费用记录 |
| 原文件已变化 | 拒绝旧提案覆盖，显示冲突并重新比较 |
| 写入或审计失败 | 不返回假成功，保留可诊断且不泄密的状态 |
| 未识别工作流版本 | 显示版本不支持，不擅自套用 V20/V26 阶段 |
| 无真实评测器 | 质量显示未知，不能用文件存在或自评分冒充通过 |

## 6. 第一批可执行切片：流程语义与交付判定契约

这个切片只建立纯函数契约，不把现有 UI 或 runner 自动切换到新路径。因此完成本节不等于完成 P0/P1，不构成发布许可。正式连接审批时，evidence 和 acceptance 必须来自服务端验证的记录，绝不能信任客户端传入的同名字段。

### 文件职责

- 新建 `engine/team-delivery-contract.mjs`：明确 V20/V25 的 S8.5 含义；基于执行、证据、验收摘要判定交付。
- 新建 `tests/unit/team-delivery-contract.test.mjs`：离线纯函数测试，不读取真实工作区，不调用模型，不写服务数据。
- 其他业务文件本切片不改；后续接线以现有 API 的实际结构另开实施计划，避免把一个纯函数误当成完整状态机。

### Task 1：先写会失败的契约测试

- [x] 新建测试文件；实际扩展为 42 项，以下保留初始计划样例。

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { stageMeaning, deliveryDecision } from '../../engine/team-delivery-contract.mjs'

const input = () => ({
  execution: 'completed',
  artifactDigest: 'sha256:fixture-a',
  evidence: { source: 'runtime', passed: true, artifactDigest: 'sha256:fixture-a' },
  acceptance: { status: 'accepted', artifactDigest: 'sha256:fixture-a' },
})

test('S8.5 is interpreted within an explicit profile and version', () => {
  assert.equal(stageMeaning('multi-ai', '20.0', 'S8.5'), 'finalize')
  assert.equal(stageMeaning('multi-ai', '25.0', 'S8.5'), 'feedback')
  assert.equal(stageMeaning('multi-ai', '26.0', 'S8.5'), null)
  assert.equal(stageMeaning('unknown', '20.0', 'S8.5'), null)
  assert.equal(stageMeaning('multi-ai', '20.0', 'S8'), null)
})

test('completion alone does not prove delivery', () => {
  const value = input()
  delete value.evidence
  assert.equal(deliveryDecision(value), 'unverified')
})

test('only matching runtime checks establish quality', () => {
  for (const evidence of [
    { source: 'model', passed: true, artifactDigest: 'sha256:fixture-a' },
    { source: 'runtime', passed: true, artifactDigest: 'sha256:older' },
    { source: 'runtime', passed: 'true', artifactDigest: 'sha256:fixture-a' },
  ]) assert.equal(deliveryDecision({ ...input(), evidence }), 'unverified')
  const value = input()
  value.evidence.passed = false
  assert.equal(deliveryDecision(value), 'quality_failed')
})

test('approval must match the checked artifact', () => {
  assert.equal(deliveryDecision({ ...input(), acceptance: null }), 'awaiting_acceptance')
  assert.equal(deliveryDecision({ ...input(), acceptance: { status: 'rejected' } }), 'rejected')
  const value = input()
  value.acceptance.artifactDigest = 'sha256:older'
  assert.equal(deliveryDecision(value), 'acceptance_stale')
  assert.equal(deliveryDecision(input()), 'ready_to_publish')
})

test('noncompleted runs and absent artifacts never publish', () => {
  for (const execution of ['queued', 'running', 'failed', 'cancelled', 'interrupted', 'unknown']) {
    assert.equal(deliveryDecision({ ...input(), execution }), 'not_ready')
  }
  assert.equal(deliveryDecision({ ...input(), artifactDigest: '' }), 'missing_artifact')
  assert.equal(deliveryDecision(null), 'not_ready')
})
```

- [x] 在隔离目录执行契约测试，确认最初因目标模块不存在而失败，再实现（代理执行记录与两轮独立审查）。

### Task 2：实现最小契约并验证

- [x] 新建模块；阶段映射仅收录已核对的冲突点，不假装实现完整工作流。以下为计划示意，实际用严格比较实现等价逻辑。

```js
const meanings = new Map([
  ['multi-ai@20.0:S8.5', 'finalize'],
  ['multi-ai@25.0:S8.5', 'feedback'],
])

export function stageMeaning(profileId, profileVersion, stageKey) {
  return meanings.get(`${profileId}@${profileVersion}:${stageKey}`) ?? null
}

export function deliveryDecision(input) {
  if (!input || input.execution !== 'completed') return 'not_ready'
  const { artifactDigest, evidence, acceptance } = input
  if (typeof artifactDigest !== 'string' || !artifactDigest.trim()) return 'missing_artifact'
  if (evidence?.source !== 'runtime' || evidence.artifactDigest !== artifactDigest) return 'unverified'
  if (evidence.passed === false) return 'quality_failed'
  if (evidence.passed !== true) return 'unverified'
  if (acceptance?.status === 'rejected') return 'rejected'
  if (acceptance?.status !== 'accepted') return 'awaiting_acceptance'
  if (acceptance.artifactDigest !== artifactDigest) return 'acceptance_stale'
  return 'ready_to_publish'
}
```

- [x] 契约模块语法检查退出码 0。
- [x] 契约测试实际扩展为 42 项，全部通过，并通过规格与质量审查。
- [x] AIBody / run-store / run-manager / 契约联合回归 72/72 通过。
- [x] diff 空白检查及新增文件直接审读完成：纯契约无秘密、文件写入或网络调用。
- [x] 契约切片通过，尚未接入业务；保留独立变更，不自动 commit、push、通知或部署。完整本批验证记录见 `2026-09-20-p0-validation.md`。

## 7. 接线后的发布门槛（不是本轮执行指令）

1. 先核对全量测试是否仍会写真实工作区，完成临时目录隔离后再运行 `npm test`。不能仅凭设置一个未经核实的环境变量声称已隔离。
2. 在隔离目录执行前端类型检查 `npx tsc --noEmit -p frontend/tsconfig.json`，并执行 `npm --prefix frontend run build`；不要在在线主目录先试构建。
3. 对改动前端运行仓库约定的 Impeccable 检查，再进行三个入口的浏览器交互验证；源码断言不能代替点击、断线恢复和小屏操作检查。
4. 对照第5节验收矩阵逐项保存证据。特别验证批准与发布之间的摘要检查、落盘失败、重启后的不确定副作用。
5. 合并前核对主工作区新改动，保留构建与数据备份；前端使用 `frontend/dist`，新增资源先就位、入口文件最后切换，不误部署到 `public`。
6. 后端变更只有确认无运行任务后，才按用户指定的 `D:/pi-web/scripts/restart-pi-web.ps1` 重启。健康检查、单实例、前端资源版本均需重新验证；不以 watchdog 自动恢复替代部署确认。

## 8. 本计划明确不承诺的内容

- 不承诺照搬 V26 即能达到文档效率指标，不承诺外部引用或平台价格已核实。
- 不把脚本静态通过、文件存在、模型自述或随机分数称作已验证能力。
- 不在这份总体规划中一次性定死视频、小说、技能的全部实现；它们按 P2/P3 独立细化并交付，避免跨子系统的大规模重写。
- 默认后续在当前任务内分批推进；若用户选择代理并行，再建立边界清楚的独立子任务。
