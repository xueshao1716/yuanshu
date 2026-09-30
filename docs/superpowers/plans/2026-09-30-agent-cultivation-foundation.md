# Agent Cultivation Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立默认拒绝的培养策略和按工作区、个体隔离的内部版本化存储，用合成数据证明它不共享母体状态。

**Architecture:** 三个小模块分别处理策略、纯记录状态和持久化。只复用既有安全路径、原子写入、文件锁；不初始化母体引擎，不接 HTTP、模型或后台任务。审计与状态在同一文件原子提交，跨文件关系留给下一阶段的幂等对账。

**Tech Stack:** Node.js ESM、node:test、node:assert/strict、现有 verificationEnvironment 与 verification-preload。

---

## 执行边界和文件职责

在 `D:/pi-web/.worktrees/agent-cultivation-ecology`、`feat/agent-cultivation-ecology` 执行。每步按红→绿→提交顺序完成；不在主目录修改别人尚未提交的立绘。建议当前会话单写入者执行，不自动派发子代理。

| 文件 | 职责 |
| --- | --- |
| `engine/cultivation/policy.mjs` | 严格字段、保守默认值、单次请求的静态许可检查；不是认证/预算结算器 |
| `engine/cultivation/state.mjs` | 合法服务端 ID、记录结构、深拷贝、版本递增、同记录追加审计 |
| `engine/cultivation/storage.mjs` | 工作区边界、固定路径、限额读写、加锁提交、冲突拒绝；不导出任意路径写入 |
| `tests/unit/cultivation-policy.test.mjs` | 默认拒绝、非法配置、过期、模型/工具/数据/远程限制 |
| `tests/unit/cultivation-state.test.mjs` | ID、数据约束、版本与审计、容量、不可变返回值 |
| `tests/unit/cultivation-storage.test.mjs` | 合成工作区、并发、重启、损坏/链接/跨作用域、失败不部分落盘 |

第一阶段政策模型只含约束，不接受或记录请求体声称的批准者。`enabled` 也不是授权证明：第二阶段只有服务确认的人类操作才可持久化启用。本阶段不暴露任何策略写入路由。

本阶段 `actor` 是内部调用者给出的审计标签，不是身份认证。下一阶段必须从认证上下文注入，不能把用户/模型传入字符串直接交给此接口。这里的 `scope` 仅允许 `control` 或服务生成的 UUID；显示名不能作为目录。

## 测试命令（每个任务均复用）

在同一个 PowerShell 会话中定义一次以下函数；它只运行指定文件，使用临时工作区和现有安全预加载，不触碰真实业务数据。不能改用裸 `npm test`。

```powershell
function Test-Cultivation([string]$TestFile) {
  node --input-type=module -e 'import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import {spawnSync} from "node:child_process"; import {pathToFileURL} from "node:url"; import {verificationEnvironment} from "./scripts/verification-runner.mjs"; const root=fs.mkdtempSync(path.join(os.tmpdir(),"yuanshu-cultivation-check-")); const result=spawnSync(process.execPath,["--import",pathToFileURL(path.resolve("scripts/verification-preload.mjs")).href,"--test","--test-concurrency=1",process.argv[1]],{env:verificationEnvironment(root),stdio:"inherit",windowsHide:true,timeout:120000}); console.log("Isolated verification root:",root); if(result.error)console.error(result.error.message); process.exitCode=result.status??1;' $TestFile
  if ($LASTEXITCODE -ne 0) { Write-Host "验证未通过（红阶段预期如此），退出码 $LASTEXITCODE" }
}
```

临时目录是合成验收记录，不在仓库中提交；执行报告列明路径。所有下面的实现代码仅为计划内容，需先运行对应失败测试才写入源文件。

## Task 1：严格且默认关闭的策略

**Files:** Create `engine/cultivation/policy.mjs`; Test `tests/unit/cultivation-policy.test.mjs`.

- [ ] **Step 1：新增完整失败测试文件。**

```javascript
// tests/unit/cultivation-policy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultPolicy, validatePolicy, assertRequest} from '../../engine/cultivation/policy.mjs';

const now = Date.parse('2026-09-30T12:00:00Z');
const active = () => ({...defaultPolicy(), enabled: true,
  expiresAt: '2026-10-01T12:00:00Z', dailyRequests: 2,
  models: ['fixture-local'], tools: ['fixture-read'], dataScopes: ['fixture-public']});
const request = () => ({model: 'fixture-local', tools: ['fixture-read'],
  dataScopes: ['fixture-public'], remote: false, costUpperBoundCents: 0});

test('默认关闭、独立数组、零预算，不继承权限', () => {
  const p = defaultPolicy();
  assert.equal(p.enabled, false);
  assert.equal(p.maxAgents, 3);
  assert.equal(p.maxConcurrent, 1);
  assert.equal(p.dailyBudgetCents, 0);
  assert.equal(p.allowRemote, false);
  assert.equal(p.recursive, false);
  p.models.push('mutated');
  assert.deepEqual(defaultPolicy().models, []);
  assert.throws(() => assertRequest(defaultPolicy(), request(), now), /policy_disabled/);
});

test('拒绝未知字段、递归、无效额度、无期限启用和空白名单项', () => {
  for (const patch of [{approvedBy: 'human'}, {recursive: true}, {dailyBudgetCents: NaN},
    {maxAgents: 0}, {maxConcurrent: 4}, {models: ['']}, {dailyRequests: -1},
    {enabled: true}, {currency: 'unconfigured'}]) {
    assert.throws(() => validatePolicy({...defaultPolicy(), ...patch}), /invalid_policy/);
  }
  const p = active();
  const copy = validatePolicy(p);
  copy.tools.push('changed');
  assert.deepEqual(p.tools, ['fixture-read']);
});

test('静态请求检查拒绝过期、越权、未知费用和超额', () => {
  assert.equal(assertRequest(active(), request(), now), true);
  assert.throws(() => assertRequest(active(), request(), now + 2 * 86400000), /policy_expired/);
  for (const patch of [{model: 'other'}, {tools: ['shell']}, {dataScopes: ['private']},
    {remote: true}, {costUpperBoundCents: null}, {costUpperBoundCents: 1},
    {tools: 'fixture-read'}]) {
    assert.throws(() => assertRequest(active(), {...request(), ...patch}, now), /request_denied/);
  }
  assert.throws(() => assertRequest({...active(), dailyRequests: 0}, request(), now), /request_denied/);
});
```

- [ ] **Step 2：运行失败测试，保留红阶段结果。**

Run: `Test-Cultivation tests/unit/cultivation-policy.test.mjs`

Expected: 非零退出，缺少 `engine/cultivation/policy.mjs` 导致 `ERR_MODULE_NOT_FOUND`。若已有模块，先检查分支状态，不覆盖其他实现。

- [ ] **Step 3：新增策略模块。**

```javascript
// engine/cultivation/policy.mjs
const fields = ['enabled', 'maxAgents', 'maxConcurrent', 'dailyRequests',
  'dailyBudgetCents', 'currency', 'allowRemote', 'recursive', 'expiresAt',
  'models', 'tools', 'dataScopes'];
const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
const list = value => Array.isArray(value) && value.length <= 64 &&
  value.every(v => typeof v === 'string' && v.length > 0 && v.length <= 200 && v.trim() === v) &&
  new Set(value).size === value.length;

export function defaultPolicy() {
  return {enabled: false, maxAgents: 3, maxConcurrent: 1, dailyRequests: 0,
    dailyBudgetCents: 0, currency: 'USD', allowRemote: false, recursive: false,
    expiresAt: null, models: [], tools: [], dataScopes: []};
}

export function validatePolicy(value) {
  const bad = () => { throw new Error('cultivation_invalid_policy'); };
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).length !== fields.length || fields.some(k => !Object.hasOwn(value, k)) ||
      Object.keys(value).some(k => !fields.includes(k))) bad();
  if (typeof value.enabled !== 'boolean' || typeof value.allowRemote !== 'boolean' ||
      value.recursive !== false || value.currency !== 'USD' ||
      !integer(value.maxAgents, 1, 20) || !integer(value.maxConcurrent, 1, value.maxAgents) ||
      value.maxConcurrent > 4 || !integer(value.dailyRequests, 0, 1000) ||
      !integer(value.dailyBudgetCents, 0, 1000000) ||
      !list(value.models) || !list(value.tools) || !list(value.dataScopes)) bad();
  const expiry = value.expiresAt;
  if (expiry !== null && (typeof expiry !== 'string' || expiry.length > 40 ||
      !Number.isFinite(Date.parse(expiry)))) bad();
  if (value.enabled && expiry === null) bad();
  return structuredClone(value);
}

// 静态约束而非资源预留；调用方仍须使用共同账本和可信身份。
export function assertRequest(policy, request, now = Date.now()) {
  const p = validatePolicy(policy);
  if (!p.enabled) throw new Error('cultivation_policy_disabled');
  if (!Number.isFinite(now) || Date.parse(p.expiresAt) <= now)
    throw new Error('cultivation_policy_expired');
  if (!request || !p.models.includes(request.model) ||
      !list(request.tools) || request.tools.some(t => !p.tools.includes(t)) ||
      !list(request.dataScopes) || request.dataScopes.some(s => !p.dataScopes.includes(s)) ||
      typeof request.remote !== 'boolean' || request.remote && !p.allowRemote ||
      !integer(request.costUpperBoundCents, 0, p.dailyBudgetCents) || p.dailyRequests === 0)
    throw new Error('cultivation_request_denied');
  return true;
}
```

`currency: USD` 是当前账本单位，不代表发生费用或已配置付费模型。上线若需多币种，先明确换算与结算契约，不能把不同币种直接累加。本模块不读取模型目录，`remote` 与费用上限必须由服务侧提供者解析，不能由模型自己声明。

- [ ] **Step 4：运行通过测试。**

Run: `Test-Cultivation tests/unit/cultivation-policy.test.mjs`

Expected: 3 tests passed、0 failed。无模型调用或业务工作区写入。

- [ ] **Step 5：检查差异并只提交这两个文件。**

```powershell
git diff --check
git add engine/cultivation/policy.mjs tests/unit/cultivation-policy.test.mjs
git diff --cached --stat
git commit -m "feat: add deny-default cultivation policy contract"
```

## Task 2：纯记录状态和追加审计

**Files:** Create `engine/cultivation/state.mjs`; Test `tests/unit/cultivation-state.test.mjs`.

基础 payload 是受限 JSON；它不是已验证设计。后续 designs/controls 负责业务结构与批准规则。审计只由提交方法追加，payload 不能覆盖审计。文件所有者仍能在文件系统改数据，这里不声称防管理员篡改。

- [ ] **Step 1：新增完整失败测试。**

```javascript
// tests/unit/cultivation-state.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validScope, emptyRecord, validateRecord, advanceRecord, MAX_AUDIT}
  from '../../engine/cultivation/state.mjs';

const workspace = 'a'.repeat(64);
const event = {actor: 'service:fixture', action: 'design.saved', at: '2026-09-30T12:00:00.000Z'};

test('仅允许 control 或 UUID，不允许人物名称或路径', () => {
  assert.equal(validScope('control'), true);
  assert.equal(validScope(randomUUID()), true);
  for (const scope of ['小语', '../mother', 'A/B', 'A\\B', '', 'CON', 'control.json'])
    assert.equal(validScope(scope), false);
});

test('推进版本不修改旧对象，状态与审计同时生成', () => {
  const base = emptyRecord(workspace, randomUUID());
  const payload = {layers: {temporary: {expression: 'serious'}, stable: {}, knowledgeRefs: []},
    appearance: {assetId: 'fixture-a'}, voice: {voiceId: 'fixture-voice'}};
  const next = advanceRecord(base, payload, event);
  assert.equal(base.revision, 0);
  assert.deepEqual(base.audit, []);
  assert.equal(next.revision, 1);
  assert.equal(next.audit[0].revision, 1);
  assert.equal(next.audit[0].actor, event.actor);
  assert.equal(next.createdAt, event.at);
  next.data.layers.temporary.expression = 'changed';
  assert.equal(payload.layers.temporary.expression, 'serious');
  const second = advanceRecord(next, {note: 'revision two'}, {...event, action: 'corrected'});
  assert.equal(second.audit.length, 2);
  assert.deepEqual(second.audit[0], next.audit[0]);
  assert.equal(validateRecord(second, workspace, base.scope).revision, 2);
});

test('拒绝损坏、异域、过大/非 JSON 数据，不绕过审计容量', () => {
  const base = emptyRecord(workspace, randomUUID());
  assert.throws(() => validateRecord(base, 'b'.repeat(64), base.scope), /invalid_record/);
  assert.throws(() => advanceRecord(base, {n: NaN}, event), /invalid_payload/);
  assert.throws(() => advanceRecord(base, {n: undefined}, event), /invalid_payload/);
  assert.throws(() => advanceRecord(base, {s: 'x'.repeat(32769)}, event), /invalid_payload/);
  assert.throws(() => advanceRecord(base, JSON.parse('{"__proto__":{}}'), event), /invalid_payload/);
  assert.throws(() => advanceRecord(base, {}, {...event, actor: ''}), /invalid_record/);
  let row = base;
  for (let i = 0; i < MAX_AUDIT; i++) row = advanceRecord(row, {n: i}, event);
  assert.equal(row.audit.length, MAX_AUDIT);
  assert.throws(() => advanceRecord(row, {}, event), /audit_full/);
  const corrupt = structuredClone(row);
  corrupt.audit[0].revision = 9;
  assert.throws(() => validateRecord(corrupt, workspace, base.scope), /invalid_record/);
});
```

- [ ] **Step 2：运行失败测试。**

Run: `Test-Cultivation tests/unit/cultivation-state.test.mjs`

Expected: `ERR_MODULE_NOT_FOUND`，尚无 state 模块。

- [ ] **Step 3：新增纯状态模块。**

```javascript
// engine/cultivation/state.mjs
export const MAX_AUDIT = 256;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fields = ['schema', 'workspace', 'scope', 'revision', 'createdAt', 'updatedAt', 'data', 'audit'];
const own = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const iso = v => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const label = v => typeof v === 'string' && v.length > 0 && v.length <= 200 &&
  !/[\x00-\x1f]/.test(v);
const fail = code => { throw new Error(`cultivation_${code}`); };

export const validScope = scope => scope === 'control' || typeof scope === 'string' && uuid.test(scope);

function jsonValue(value, depth = 0) {
  if (depth > 12) fail('invalid_payload');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value === 'string' && value.length <= 32768) return;
  if (Array.isArray(value) && value.length <= 256) {
    for (let i = 0; i < value.length; i++) jsonValue(value[i], depth + 1);
    return;
  }
  if (own(value) && Object.keys(value).length <= 256) {
    for (const key of Object.keys(value)) {
      if (!label(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) fail('invalid_payload');
      jsonValue(value[key], depth + 1);
    }
    return;
  }
  fail('invalid_payload');
}

export function emptyRecord(workspace, scope) {
  const row = {schema: 1, workspace, scope, revision: 0,
    createdAt: null, updatedAt: null, data: {}, audit: []};
  return validateRecord(row, workspace, scope);
}

export function validateRecord(row, workspace, scope) {
  if (!/^[0-9a-f]{64}$/.test(workspace) || !validScope(scope) || !own(row) ||
      Object.keys(row).length !== fields.length || fields.some(k => !Object.hasOwn(row, k)) ||
      row.schema !== 1 || row.workspace !== workspace || row.scope !== scope ||
      !Number.isSafeInteger(row.revision) || row.revision < 0 || !own(row.data) ||
      !Array.isArray(row.audit) || row.audit.length > MAX_AUDIT || row.audit.length !== row.revision)
    fail('invalid_record');
  jsonValue(row.data);
  if (row.revision === 0) {
    if (row.createdAt !== null || row.updatedAt !== null || Object.keys(row.data).length) fail('invalid_record');
  } else if (!iso(row.createdAt) || !iso(row.updatedAt)) fail('invalid_record');
  for (const [index, item] of row.audit.entries()) {
    if (!own(item) || Object.keys(item).length !== 4 || item.revision !== index + 1 ||
        !label(item.actor) || !label(item.action) || !iso(item.at) ||
        index > 0 && Date.parse(item.at) < Date.parse(row.audit[index - 1].at)) fail('invalid_record');
  }
  if (row.revision && (row.createdAt !== row.audit[0].at ||
      row.updatedAt !== row.audit.at(-1).at)) fail('invalid_record');
  return structuredClone(row);
}

export function advanceRecord(previous, data, event) {
  const row = validateRecord(previous, previous.workspace, previous.scope);
  if (row.audit.length >= MAX_AUDIT) fail('audit_full');
  if (!event || !label(event.actor) || !label(event.action) || !iso(event.at)) fail('invalid_record');
  if (!own(data)) fail('invalid_payload');
  jsonValue(data);
  const at = row.updatedAt && Date.parse(row.updatedAt) > Date.parse(event.at) ? row.updatedAt : event.at;
  row.revision++;
  row.createdAt ??= at;
  row.updatedAt = at;
  row.data = structuredClone(data);
  row.audit.push({revision: row.revision, actor: event.actor, action: event.action, at});
  return validateRecord(row, previous.workspace, previous.scope);
}
```

审计上限 256 是第一阶段的明确安全上限，到达后拒绝写入，绝不删除旧事件或自动“压缩掉”。阶段 2 若需要提高容量，必须一并设计归档清单与分页投影，并做断电/部分归档回归测试；第一阶段不用于高频运行事件。

- [ ] **Step 4：运行通过测试。**

Run: `Test-Cultivation tests/unit/cultivation-state.test.mjs`

Expected: 3 tests passed、0 failed。确认 MAX_AUDIT 循环在隔离超时内完成。

- [ ] **Step 5：只提交状态模块及测试。**

```powershell
git diff --check
git add engine/cultivation/state.mjs tests/unit/cultivation-state.test.mjs
git diff --cached --stat
git commit -m "feat: add isolated cultivation state envelopes"
```

## Task 3：加锁、原子、版本化的隔离存储

**Files:** Create `engine/cultivation/storage.mjs`; Test `tests/unit/cultivation-storage.test.mjs`.

文件布局：`工程/智能体培养/control.json` 和 `工程/智能体培养/agents/<UUID>/state.json`。工作区指纹使用真实规范路径的 SHA-256；Windows 忽略路径大小写。路径不可通过调用参数指定；不读取或复制母体目录。

- [ ] **Step 1：新增完整失败测试。**

```javascript
// tests/unit/cultivation-storage.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {initFileLock} from '../../engine/file-lock.mjs';
import {reviewAtomicWrite} from '../../engine/review-file-safety.mjs';
import {createCultivationStorage} from '../../engine/cultivation/storage.mjs';

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-cultivation-storage-'));
  const a = path.join(temp, 'a'), b = path.join(temp, 'b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  initFileLock({dir: path.join(temp, 'locks')});
  t.after(() => fs.rmSync(temp, {recursive: true, force: true}));
  return {temp, a, b};
}
const change = (data, expectedRevision = 0) => ({expectedRevision, data,
  actor: 'service:fixture', action: 'saved'});
const fileFor = (root, id) => path.join(root, '工程', '智能体培养', 'agents', id, 'state.json');

test('空读取不写盘；孩子、工作区和返回对象不串；重启保持状态', async t => {
  const {a, b} = fixture(t), one = randomUUID(), two = randomUUID();
  const store = createCultivationStorage({wsRoot: a});
  assert.equal(store.read(one).revision, 0);
  assert.deepEqual(fs.readdirSync(a), []);
  const media = {appearance: {assetId: 'fixture-a'}, voice: {voiceId: 'fixture-voice'},
    layers: {temporary: {expression: 'serious'}, stable: {}, knowledgeRefs: []}, status: 'paused'};
  const saved = await store.commit(one, change(media));
  saved.data.voice.voiceId = 'mutated';
  assert.equal(store.read(one).data.voice.voiceId, 'fixture-voice');
  assert.deepEqual(store.read(two).data, {});
  assert.deepEqual(createCultivationStorage({wsRoot: b}).read(one).data, {});
  const restarted = createCultivationStorage({wsRoot: a});
  assert.equal(restarted.read(one).data.status, 'paused');
  assert.equal(restarted.read(one).audit.length, 1);
  assert.equal(fs.existsSync(path.join(a, '记忆')), false);
  const copied = fileFor(b, one);
  fs.mkdirSync(path.dirname(copied), {recursive: true});
  fs.copyFileSync(fileFor(a, one), copied);
  assert.throws(() => createCultivationStorage({wsRoot: b}).read(one), /invalid_record/);
});

test('同版本并发只能一次成功；失败不会写状态或追加审计', async t => {
  const {a} = fixture(t), id = randomUUID();
  const first = createCultivationStorage({wsRoot: a});
  const second = createCultivationStorage({wsRoot: a});
  const results = await Promise.allSettled([
    first.commit(id, change({value: 1})), second.commit(id, change({value: 2}))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /revision_conflict/);
  const before = fs.readFileSync(fileFor(a, id), 'utf8');
  const brokenWriter = createCultivationStorage({wsRoot: a,
    atomicWrite: () => {throw new Error('fixture_write_failure');}});
  await assert.rejects(brokenWriter.commit(id, change({value: 3}, 1)), /fixture_write_failure/);
  assert.equal(fs.readFileSync(fileFor(a, id), 'utf8'), before);
  assert.equal(first.read(id).audit.length, 1);
  await assert.rejects(first.commit(id, change({value: 4}, 0)), /revision_conflict/);
  assert.equal(fs.readFileSync(fileFor(a, id), 'utf8'), before);
});

test('拒绝路径、链接、损坏 JSON，不能自动重建覆盖', async t => {
  const {temp, a, b} = fixture(t), id = randomUUID();
  const store = createCultivationStorage({wsRoot: a});
  assert.throws(() => store.read('../mother'), /invalid_scope/);
  await store.commit(id, change({note: 'safe'}));
  const file = fileFor(a, id);
  fs.writeFileSync(file, '{broken fixture');
  assert.throws(() => store.read(id), /state_unreadable/);
  await assert.rejects(store.commit(id, change({note: 'overwrite'}, 1)), /state_unreadable/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken fixture');
  const linkedRoot = path.join(temp, 'linked-root');
  fs.symlinkSync(b, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => createCultivationStorage({wsRoot: linkedRoot}), /path_denied/);
  const inner = path.join(b, '工程');
  fs.symlinkSync(a, inner, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => createCultivationStorage({wsRoot: b}).read('control'), /链接/);
});

test('写入前拒绝过大记录；共享硬链接拒绝读取', async t => {
  const {temp, a} = fixture(t), id = randomUUID();
  let writes = 0;
  const store = createCultivationStorage({wsRoot: a, atomicWrite: (file, text) => {
    writes++; reviewAtomicWrite(file, text);
  }});
  const huge = Object.fromEntries(Array.from({length: 100}, (_, i) => [`field${i}`, 'x'.repeat(30000)]));
  await assert.rejects(store.commit(id, change(huge)), /storage_full/);
  assert.equal(writes, 0);
  assert.equal(store.read(id).revision, 0);
  await store.commit(id, change({note: 'small'}));
  fs.linkSync(fileFor(a, id), path.join(temp, 'duplicate.json'));
  assert.throws(() => store.read(id), /链接/);
});
```

夹具销毁只针对 `mkdtemp` 返回的自有临时路径。Windows junction 测试失败应报告真实平台限制，不静默 skip；不修改真实文件夹或取消路径防护来让它通过。

- [ ] **Step 2：运行失败测试。**

Run: `Test-Cultivation tests/unit/cultivation-storage.test.mjs`

Expected: `ERR_MODULE_NOT_FOUND`，缺少 storage 模块。

- [ ] **Step 3：新增存储模块。**

```javascript
// engine/cultivation/storage.mjs
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {withFileLock} from '../file-lock.mjs';
import {reviewStoragePath, reviewAtomicWrite} from '../review-file-safety.mjs';
import {readReviewBounded} from '../review-read.mjs';
import {emptyRecord, validateRecord, advanceRecord, validScope} from './state.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
export function createCultivationStorage({wsRoot, now = () => new Date().toISOString(),
  atomicWrite = reviewAtomicWrite}) {
  if (typeof wsRoot !== 'string' || fs.lstatSync(wsRoot).isSymbolicLink())
    throw new Error('cultivation_path_denied');
  const root = fs.realpathSync(wsRoot);
  if (!fs.statSync(root).isDirectory()) throw new Error('cultivation_path_denied');
  const canonical = process.platform === 'win32' ? root.toLowerCase() : root;
  const workspace = createHash('sha256').update(canonical).digest('hex');
  const location = scope => {
    if (!validScope(scope)) throw new Error('cultivation_invalid_scope');
    const relative = scope === 'control' ? 'control.json' : `agents/${scope}/state.json`;
    return reviewStoragePath(root, `工程/智能体培养/${relative}`);
  };
  const read = scope => {
    const file = location(scope);
    let data;
    try { data = JSON.parse(readReviewBounded(file, MAX_BYTES).toString('utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return emptyRecord(workspace, scope);
      throw new Error('cultivation_state_unreadable', {cause: error});
    }
    return validateRecord(data, workspace, scope);
  };
  const commit = async (scope, command) => {
    // 在等待锁之前快照命令，调用者后续改对象不改变本次请求。
    const input = structuredClone(command);
    if (!input || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
      throw new Error('cultivation_revision_conflict');
    return withFileLock(location(scope), () => {
      const previous = read(scope);
      if (previous.revision !== input.expectedRevision) throw new Error('cultivation_revision_conflict');
      const next = advanceRecord(previous, input.data,
        {actor: input.actor, action: input.action, at: now()});
      const text = JSON.stringify(next);
      if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('cultivation_storage_full');
      // 持锁后再次检查链接边界；原子写失败不得返回已提交。
      atomicWrite(location(scope), text);
      return structuredClone(next);
    });
  };
  return Object.freeze({workspace, read, commit});
}
```

`atomicWrite` 注入仅供受信任的内部构造与故障测试，不出现在 HTTP 参数或模型工具配置中。调用底层原语沿用现有路径检查模型，不声称能抵抗持有本机文件系统权限者精确制造的链接替换竞态。

此处每个 scope 读取最多 2MiB；没有列目录/全库扫描接口。后续控制面板通过带失效策略的投影查询，不以每次轮询重新解析所有个体文件实现列表。

- [ ] **Step 4：运行通过测试并回归前两个模块。**

```powershell
Test-Cultivation tests/unit/cultivation-storage.test.mjs
Test-Cultivation tests/unit/cultivation-policy.test.mjs
Test-Cultivation tests/unit/cultivation-state.test.mjs
```

Expected: storage 4 项、policy 3 项、state 3 项通过，均 0 失败。这里测试的是同进程两实例锁；跨进程压力和宿主重启对账属于阶段 2/3，不以这个结果替代。

- [ ] **Step 5：检查提交范围并提交存储模块和测试。**

```powershell
git diff --check
git add engine/cultivation/storage.mjs tests/unit/cultivation-storage.test.mjs
git diff --cached --stat
git commit -m "feat: persist cultivation state with revision and audit isolation"
```

## 第一阶段收口

- [ ] 检查三个模块均未导入母体初始化、模型执行器、网络或定时器。Run: `rg -n 'gene\.mjs|emotion\.mjs|setInterval|fetch\(' engine/cultivation`。Expected: 无匹配，rg 返回 1 表示未命中，而非测试失败。
- [ ] 复验既有基础依赖：`Test-Cultivation tests/unit/knowledge-storage.test.mjs`、`Test-Cultivation tests/unit/knowledge-store.test.mjs`、`Test-Cultivation tests/unit/knowledge-budget.test.mjs`。Expected: 共 10 项通过；出现基线差异先报告，不改无关代码。
- [ ] 阅读实际差异：`git diff b6612424 --stat` 和 `git status --short`。Expected: 仅本计划文档与列出的 6 个源/测试文件；无 `frontend/dist`、真实 workspace、token、域名或媒体产物。
- [ ] 报告实际红/绿结果、提交号和未验证边界。第一阶段没有前端修改，不声称 tsc/build/E2E 已通过；完整闭环合并前另跑隔离 `npm run verify`。

阶段结束只证明内部基础可用。用户身份、设计业务校验、模型调用、预算预留、经验采用、观察面板尚未开放，不能称为“已能养智能体”。阶段 2 接着根据路线图细化，不重新请求批准同一份设计。
