# 元枢证据驱动进化：第一阶段实施计划

> **For agentic workers:** Use subagent-driven-development for implementation and separate specification/quality review. Follow TDD and preserve unrelated files.

**Goal:** 接通客观交付检查与学习资格，阻止未经独立核对的提示词变体写回。

**Architecture:** 沿用任务验收、进化提案池与人工审批。不扩展权限、不改变人格、不批量认可旧记录。文件检查只提供窄范围事实；技能正确性仍需独立确认。模型评测仅供参考，人工须看到同题原版/候选实际回答，逐项核对后才能应用。

**Tech Stack:** Node.js、原生 node:test、React/TypeScript、现有隔离验证器。

## 1. 提示词实验与独立审批

Files: engine/evolution-api.mjs, new engine/evolution-evaluation.mjs, server.mjs, frontend/src/pages/Apps.tsx, new frontend/src/components/EvolutionReview.tsx, frontend/src/api.ts, tests/unit/evolution*.test.mjs.

- [x] 写失败测试：未评测不可应用；评测与原文及所有候选内容绑定；旧评分不可冒充新评测；缺失/畸形分数不计有效评分；并发评测去重；评测完成不得覆盖期间其他提案修改。
- [x] 将评测提取为有限执行的独立模块：最多4题、2候选；保留完整但有长度上限的回答与分数，错误明确可见；计时器清理；请求超时停止后续调用。
- [x] 保持模型评分 advisory。应用额外要求 evaluationId、逐题人工比较 equal/better/worse、说明；不接受 worse，至少一项 better。全部记录与提案指纹绑定。旧入口不能绕过。
- [x] 在现有页面展示同题原版与候选回答，逐项独立核对及说明；缺少条件禁用应用。替换旧轮询，正确展示 running/failed/completed，卸载清理。
- [x] 原模板写回与备份保持原机制；测试成功写回及备份内容，不改变其他审批类型。

Example acceptance contract:
```js
assert.ok(applyEvolution(id, 0).error);
assert.ok(applyEvolution(id, 0, { evaluationId: 'stale', comparisons: ['better'], note: 'checked' }).error);
// Valid review must cover EVERY persisted case for the selected candidate.
```

## 2. 客观交付事实进入现有学习入口

Files: new engine/task-evidence-objective.mjs, engine/task-evidence-artifacts.mjs, engine/task-evidence.mjs, frontend/src/components/TaskEvidenceEditor.tsx, frontend/src/lib/task-evidence-api.ts, tests/unit/task-evidence-objective.test.mjs.

- [x] 写失败测试：伪装图片、空文件、非法JSON失败；未知格式 UNVERIFIED；图片只声称头部尺寸，不冒充完整解码；正确文件不能自动获得技能标签。
- [x] 在现有受限读取结果上计算客观事实，不重复无限读取、不执行HTML/JS、不联网。事实绑定现有文件哈希；汇总基础检查 PASS/FAIL/UNVERIFIED。
- [x] 客观FAIL阻止产生正向技能学习样本，即使旧人工记录曾通过；不自动修改历史验收。人工明确验证且无客观失败的样本沿原有学习入口生效，附窄范围检查记录。文件变化继续使验收过期。
- [x] 原验收页显示检查范围及限制；不把尺寸或文件存在解释成设计质量合格。

Example acceptance contract:
```js
assert.equal(inspectArtifactBytes('image.png', Buffer.from('not an image')).status, 'FAIL');
assert.equal(inspectArtifactBytes('page.html', Buffer.from('<html></html>')).status, 'UNVERIFIED');
assert.equal(service.get(run.id).eligible, false); // failed objective check, even if human pass
```

## 3. 验收与交付

- [x] 建立独立工作区，基线定向测试34/34通过。
- [x] 先分别验证新增失败测试，再验证实现后的通过结果；全部测试使用临时工作空间。
- [x] `npm run verify`：完整测试、类型检查、非线上构建。
- [x] 对修改前端运行Impeccable检查，并针对审批入口做隔离页面验收。
- [x] 需求审查后代码质量审查；修复重要问题，重新验证。
- [x] 报告实现、测试、部署状态及剩余边界。未通过验收不重启生产、不推送；本轮不调用收费模型、不做自主实验。

Deferred: 无人值守探索预算、跨模型客观质量基准、自动通用规则提炼/上线。这一阶段只补证据和采用闸门，不宣称已实现完整自进化。

## 验证记录（2026-09-25）

- 独立工作区：`D:/pi-web/.worktrees/evolution-evidence`，分支 `feat/evolution-evidence`；基线 `9994d630`。
- 全量隔离验证：2183/2183 测试通过，无跳过；TypeScript 与构建通过。构建写入 `tmp/verification-dist`，未覆盖正式服务前端。
- `tests/e2e/evolution-review.playwright.mjs`：1440/390 宽度均通过；未核对、退步阻断、重新评测清空选择、实际写回与原文备份、失败展示、无横向溢出及页面错误均覆盖。使用模拟模型，没有付费调用。
- `tests/e2e/task-evidence.playwright.mjs`：新构建下两种宽度均通过验收、持久化、撤销、文件变化冲突、覆盖率、团队边界、布局与 HTTP 检查。旧构建曾因提案列表缺失而失败，已用可选访问修正并在新构建复测。
- 额外阻断半截评测回答、记录通道返回的实际模型、禁用评测工具调用、将遗留运行中记录显示为中断；定向回归通过。
- Impeccable 检测无发现；`git diff --check` 通过。
- 子代理返回异常后由主代理接管实施及需求/质量检查；不声称完成了独立代理审查。
- 截图已生成，但当前图片查看工具不可用；仅确认浏览器交互与布局几何结果，不声称已完成视觉截图审查。
- 正式仓库已跟踪文件无改动，保留用户原有未跟踪文件。尚未合并、部署、重启、推送或打包，版本仍为 2.116.5。
- 本阶段不涉及人格、身份、基因或权限；不将基础文件检查、模型自评等同于完整质量验证。
