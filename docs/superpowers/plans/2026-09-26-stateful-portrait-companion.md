# Stateful Portrait Companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Connect the realistic companion and emotion tide to a shared, truthful state, with session-isolated model interaction.

**Architecture:** A non-consuming emotion snapshot feeds all visual consumers. A tool-less decision service reads sanitized current-session facts; runtime constraints override model presentation. A controlled portrait manifest handles seven poses, with explicit missing-asset fallback.

**Tech Stack:** Node ES modules, node:test, React/TypeScript, SWR, existing model adapter and authentication.

**Approved specification:** `docs/superpowers/specs/2026-09-26-stateful-portrait-companion-design.md` (user approved implementation after its publication).

**Workspace:** `.worktrees/stateful-companion`, branch `feat/stateful-companion`. Preserve dirty main checkout and served dist. No production restart, push, real user-task mutation, or native repack during implementation.

## Task 1: Shared non-consuming emotion contract

Files: `engine/emotion.mjs`; new `engine/emotion-display.mjs`; `server.mjs`; `frontend/src/api.ts`; `frontend/src/lib/useXiaoyuEmotion.ts`; new snapshot-order helper beside hook; `tests/unit/emotion-display.test.mjs`.

- [ ] Write failing isolated tests for repeat reads, preservation of legacy tag consumption, missing observations, privacy whitelist, stable revisions and epoch/revision ordering.

```js
const first = display.read();
const second = display.read();
assert.deepEqual(first.state, second.state);
assert.equal(first.revision, second.revision);
assert.equal(first.scope, 'global-latest');
assert.equal(JSON.stringify(first).includes('private path'), false);
```

- [ ] Run `node --import ./scripts/verification-preload.mjs --test tests/unit/emotion-display.test.mjs`; confirm new contract fails before implementation. Tests create temporary roots; never use production data.
- [ ] Implement a safe non-consuming emotion peek plus display adapter: `{state,scope,observedAt,servedAt,sourceKind,revision,serverEpoch,status}`. Only allowed finite numeric VAD/intensity and fixed emotion/tag enums are exposed; never expose residue/genome/session keys. Unknown timestamps remain null; no observation is unavailable, persisted residue historical. Do not change legacy `getSnapshot()` tag consumption.
- [ ] Add authenticated `GET /api/companion/emotion` and typed API wrapper. Shared SWR hook uses this endpoint, 20s polling and 60s stale deadline. Old SSE events trigger revalidation only. Reject older same-epoch responses; epoch changes require authoritative refresh. Missing meta says no observation instead of focus.
- [ ] Run targeted tests plus existing emotion/portrait tests and typecheck. Commit only task paths. Independent spec review then quality review before next task.

## Task 2: Truthful facts and bounded model decisions

Files: new `engine/companion-facts.mjs`, `engine/companion-decision.mjs`, `engine/companion-policy.mjs`, `engine/companion-store.mjs`, `engine/companion-api.mjs`; scoped `server.mjs` wiring; `tests/unit/companion-*.test.mjs`.

- [ ] Write failing tests with injected clock, run manager, session reader, and model caller. Cases: other-session secret never in prompt, read start/end evidence, working beats sleep, unknown beats idle, stale revision/context/run rejected, idempotent interaction, request timeout/cancellation, quotas, bounded history, persistent DND.

```js
assert.equal(resolveAction({known:true,currentBusy:true,reading:false}, {action:'resting'}), 'working');
assert.equal(resolveAction({known:false}, {action:'resting'}), 'neutral');
assert.equal(JSON.stringify(buildContext(currentSession)).includes(otherSessionSecret), false);
```

- [ ] Run each new test file with verification preload; record red results.
- [ ] Facts contract: `{sessionId,serverEpoch,revision,observedAt,known,currentBusy,otherBusy,reading,evidenceIds}`. Read current run events only; reading requires an active read tool and its completion removes evidence. Other sessions contribute counts only. Session IDs must resolve through existing storage; no arbitrary filesystem paths and no opening agents for reads.
- [ ] Decisions use registered session model/default and existing direct adapter with tools absent, maxTokens bounded and 12s abort timeout. Last six current-session user/assistant messages capped at 6000 characters; no tool result payloads or global private emotion. Return actual model, no silent fallback, no fabricated dialogue on failure.
- [ ] Validate structured output: allowed seven actions, expression enums, plain utterance <=80, concise reason, evidence subset, duration 5–60s, decision ID, session, context epoch, basis revision, expiry, actualModel, decisionSource. Re-read facts after await. Runtime facts outrank DND/rest then model. Reject unknown actions, markup, arbitrary URLs and extra tool instructions.
- [ ] Server quotas shared across tabs: 1 in-flight/session and 2 total; auto >=30s/20h, manual >=2s/60h; failure backoff60s (explicit next interaction may retry). Bounded idempotency/state, history7days/1000, no full prompt copies. DND persisted in workspace. No default emotion mutation: interaction logging must be idempotent and must not duplicate normal chat evaluation.
- [ ] Authenticated namespace GET facts/preferences/history and POST decision/preferences. Browser hidden automatic calls are rejected/skipped. Transport disconnect aborts model work. Tests use temp stores; no live side effects.
- [ ] Run targeted tests, full verify and independent ordered reviews, then scoped commit.

## Task 3: Single portrait UI and tide-linked controller

Files: `frontend/src/components/XiaoyuWidget.tsx`; `frontend/src/components/xiaoyu/{widget-state.mjs,widget-state.d.mts,WidgetPanel.tsx,portrait.css}`; new `useCompanion.ts`, `companion-state.mjs/.d.mts`, `PortraitState.tsx`; `frontend/src/api.ts`; focused unit/e2e tests. Integrate original dirty `MoodPanel.tsx` surgically only after worktree implementation is validated.

- [ ] Write failing tests for old-skin migration, unique portrait entry, fallback honesty, session/epoch/expiry race rejection, hidden-page automatic suppression, no random or clock-driven model interaction.

```js
assert.equal(normalizeSkin('doll-puppet'), 'portrait');
assert.equal(normalizeSkin(null), 'portrait');
assert.equal(acceptDecision(oldSessionDecision, currentContext), false);
assert.equal(portraitFor('reading', manifest).missing, true); // until actual asset accepted
```

- [ ] Run tests red. Implement controller from actual current session context; 500ms event coalescing, automatic decision only changed facts/emotion/session, no polling model loop. Apply facts immediately, clear old bubbles on session/visibility change, abort superseded fetches, timer expiry returns neutral but preserves factual badge.
- [ ] Replace cartoon/studio entries with portrait presentation and action/source label. Keep drag, position, zoom/hide/reset, keyboard escape/focus, touch targets, reduced motion, update check. No face mirroring or roaming.
- [ ] Add explicit tap/text/busy/rest/DND interactions, model response as text, close bubble, clear unavailable state and actual model. Task requests require explicit bring-to-chat user action; never auto-execute. DND doesn't silence task alerts or cancel tasks.
- [ ] Both tide panel and widget use same envelope/VAD visual mapping; global/latest source and stale/no-observation labels visible. Do not display zero as real missing measurement or use old cartoon in linked panel.
- [ ] Run tests/types/non-production build and changed-file visual detector. Browser exercise at desktop/mobile widths, keyboard and reduced-motion. Review then commit scoped files.

## Task 4: Portrait assets and end-to-end acceptance

Files: `frontend/public/assets/portraits/yuanshu-*-v2.webp`; controlled manifest module plus provenance JSON; `scripts/verify-companion-live.mjs`; acceptance document.

- [ ] Follow imagegen skill; use user-authorized configured GPT image route only. Existing cutout is identity/reference and neutral fallback. Generate distinct working, reading, resting, daydreaming, listening and responding variants, fully clothed same adult fictional identity. Keep original image intact.
- [ ] Decode all variants, record dimensions/alpha/provenance and visually inspect face/hands/clothes/props/edges. Manifest may mark accepted only with genuine inspection; missing/failed states remain explicitly missing. Do not substitute one image or fake pose changes for six assets.
- [ ] Run configured model against isolated evaluation session/fake runtime evidence with real model transport: working + ask busy -> completion -> rest -> new task. Record actual model, returned actions and facts; no real user session prompt changes. Exercise limits/failure with injected transport separately.
- [ ] Run `npm run verify`, scoped detector, browser desktop/mobile acceptance. Inspect main dirty diff before integration; retain user work. Update implementation status/spec and remaining blockers accurately. No incomplete-asset/real-model completion claim.

## Acceptance / integration log

### 2026-09-26 实施进度（勾选仅表示下述事实）

- [x] 非消费式情绪读取、隐私白名单、版本/重启顺序与缺失/历史/过期标识已实现。
- [x] 当前会话事实、限额/取消/幂等、无工具模型互动、持久化免打扰与草稿交接已实现。
- [x] 卡通入口迁移为真人；顶栏、展开面板、公仔共用情绪；展开面板和公仔共用唯一动作控制器。
- [x] 真实 glm-5.3-flash 隔离三阶段验证 working/resting/working 通过；其他通道失败保留记录，不视为全模型支持。
- [ ] 六种新动作素材及逐图视觉验收（当前仅基础立绘，缺失状态明确提示）。
- [ ] 主工作区重叠变更合并、独立审查、分步提交、生产部署和重启。

原任务清单中的“测试+提交+独立审查”复合项没有整体完成，保留未勾选；具体代码与验收证据以验收记录为准。

- Baseline verification running before implementation; inspect `tmp/review-verification.json` and all check logs.
- Main checkout has unrelated/overlapping uncommitted UI work, including untracked MoodPanel. Preserve it; do not wholesale replace ChatArea or styles.
- Production deployment is a separate coordinated step requiring backend restart and active-task check. Pure web changes do not require native installers.
