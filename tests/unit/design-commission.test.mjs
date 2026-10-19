// 设计委托（2026-10-19）。
// 对标 Lovart 2.0：目标 + 交付件 → 可试跑 → 可周期 → 积分上限当熔断器 → 每次交执行报告。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createCommission, listCommissions, readCommission, runCommission, setStatus,
  removeCommission, dueCommissions, formatCommission, commissionExtraExecutors, verifyArtifact,
} from '../../engine/design-commission.mjs'

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), 'commission-'))
const NOW = new Date('2026-10-19T14:00:00Z').getTime()
const fakeGen = (urls) => {
  let i = 0
  return async () => ({ url: urls[i++] || '/api/ws/file?path=x.png' })
}

test('创建：交付件去重截断、额度默认 10、周期 <15 分钟按单次处理', () => {
  const root = ws()
  const c = createCommission(root, { title: '双11主视觉', goal: '电商大促', brief: { deliverables: ['主海报', '竖版', '主海报'] }, everyMinutes: 5 }, { now: NOW })
  assert.equal(c.id.length > 3, true)
  assert.equal(c.cap, 10)
  assert.equal(c.everyMinutes, 0, '不足 15 分钟不接周期')
  assert.deepEqual(c.brief.deliverables, ['主海报', '竖版', '主海报'])
  assert.equal(listCommissions(root).length, 1)
})

test('试跑：按交付件各出一次图，成功即 done，并产出报告', async () => {
  const root = ws()
  const c = createCommission(root, { title: 't', subject: '测试主体', goal: 'g', provider: 'p', modelId: 'm', brief: { deliverables: ['A', 'B'] }, cap: 5 }, { now: NOW })
  const r = await runCommission(root, c.id, { generate: fakeGen(['/u1.png', '/u2.png']), now: NOW })
  assert.equal(r.ok, true)
  assert.equal(r.report.files.length, 2)
  assert.equal(r.report.spent, 2)
  const back = readCommission(root, c.id)
  assert.equal(back.status, 'done')
  assert.equal(back.spent, 2)
})

test('熔断：到上限立刻停，不再出图', async () => {
  const root = ws()
  const c = createCommission(root, { title: 't', subject: '测试主体', goal: 'g', brief: { deliverables: ['A', 'B', 'C'] }, cap: 2 }, { now: NOW })
  const r = await runCommission(root, c.id, { generate: fakeGen(['/1.png', '/2.png', '/3.png']), now: NOW })
  assert.equal(r.commission.spent, 2, '只花 2 点')
  assert.equal(r.commission.status, 'capped')
  assert.equal(r.report.files.length, 2)
  // 再跑一次：直接 capped，不调 generate
  let called = 0
  const again = await runCommission(root, c.id, { generate: async () => { called++; return { url: '/x' } }, now: NOW })
  assert.equal(again.ok, false)
  assert.equal(again.reason, 'capped')
  assert.equal(called, 0)
})

test('单件失败不影响其他件，并如实写进报告', async () => {
  const root = ws()
  const c = createCommission(root, { title: 't', subject: '测试主体', goal: 'g', brief: { deliverables: ['A', 'B'] }, cap: 5 }, { now: NOW })
  let n = 0
  const gen = async () => { n++; if (n === 1) throw new Error('上游 500'); return { url: '/ok.png' } }
  const r = await runCommission(root, c.id, { generate: gen, now: NOW })
  assert.equal(r.report.files.length, 1)
  assert.equal(r.report.errors.length, 1)
  assert.match(r.report.errors[0].error, /500/)
  assert.equal(r.ok, false)
})

test('巡检问题会进报告（error 级让整体不通过）', async () => {
  const root = ws()
  const c = createCommission(root, { title: 't', subject: '测试主体', goal: 'g', brief: { deliverables: ['A'], ratios: { image: 1.7778 } }, cap: 5 }, { now: NOW })
  const r = await runCommission(root, c.id, {
    generate: fakeGen(['/a.png']), now: NOW,
    audit: async () => ({ ok: false, issues: [{ level: 'error', code: 'ratio_mismatch', message: '比例不对' }] }),
  })
  assert.equal(r.ok, false)
  assert.equal(r.report.issues.length, 1)
})

test('空镜（empty_frame）即使只是 warn 也算不通过', async () => {
  const root = ws()
  const c = createCommission(root, { title: 't', subject: '测试主体', goal: 'g', brief: { deliverables: ['A'] }, cap: 5 }, { now: NOW })
  const r = await runCommission(root, c.id, {
    generate: fakeGen(['/a.png']), now: NOW,
    audit: async () => ({ ok: true, issues: [{ level: 'warn', code: 'empty_frame', message: '疑似空镜' }] }),
  })
  assert.equal(r.ok, false, '纯色画面等于没交付')
  assert.equal(r.commission.lastReport.ok, false)
})

test('周期委托：下一轮到期才算 due，跑完自动排下一次', async () => {
  const root = ws()
  const c = createCommission(root, { title: 't', subject: '测试主体', goal: 'g', brief: { deliverables: ['A'] }, cap: 10, everyMinutes: 60 }, { now: NOW })
  assert.equal(dueCommissions(root, { now: NOW }).length, 0, '才创建，还没到期')
  assert.equal(dueCommissions(root, { now: NOW + 61 * 60000 }).length, 1)
  await runCommission(root, c.id, { generate: fakeGen(['/a.png']), now: NOW + 61 * 60000 })
  const back = readCommission(root, c.id)
  assert.equal(back.status, 'running')
  assert.equal(back.nextRunAt, NOW + 121 * 60000)
})

test('暂停后不跑；额度用尽时不再出现在 due 列表', async () => {
  const root = ws()
  const c = createCommission(root, { title: 't', subject: '测试主体', goal: 'g', brief: { deliverables: ['A'] }, cap: 1, everyMinutes: 60 }, { now: NOW })
  setStatus(root, c.id, 'paused', { now: NOW })
  const paused = await runCommission(root, c.id, { generate: fakeGen(['/a.png']), now: NOW + 999999 })
  assert.equal(paused.reason, 'paused')
  setStatus(root, c.id, 'running', { now: NOW })
  await runCommission(root, c.id, { generate: fakeGen(['/a.png']), now: NOW + 61 * 60000 })
  assert.equal(readCommission(root, c.id).status, 'capped')
  assert.equal(dueCommissions(root, { now: NOW + 999999 }).length, 0)
})

test('工具：create / list / run / report 都能用', async () => {
  const root = ws()
  const exec = commissionExtraExecutors(root, { generate: fakeGen(['/a.png']), now: () => NOW }).commission
  const created = await exec({ action: 'create', title: '主视觉', subject: '一颗白球', goal: '电商', deliverables: ['主海报'], cap: 3 })
  assert.equal(created.isError, false)
  const id = /\[(c[0-9a-z]+)\]/.exec(created.text)[1]
  const listed = await exec({ action: 'list' })
  assert.match(listed.text, /主视觉/)
  const ran = await exec({ action: 'run', id })
  assert.equal(ran.isError, false)
  assert.match(ran.text, /试跑完成/)
  const reported = await exec({ action: 'report', id })
  assert.match(reported.text, /交付/)
})

test('删除只删一条', () => {
  const root = ws()
  const a = createCommission(root, { title: 'a', goal: 'g' }, { now: NOW })
  createCommission(root, { title: 'b', goal: 'g' }, { now: NOW })
  assert.equal(removeCommission(root, a.id).ok, true)
  assert.equal(listCommissions(root).length, 1)
})

test('没主体不许出图：run 直接拒绝并给出要问的问题，一分钱不花', async () => {
  const root = ws()
  const c = createCommission(root, { title: '空提示', goal: '极简', brief: { deliverables: ['A'] }, cap: 5 }, { now: NOW })
  let called = 0
  const r = await runCommission(root, c.id, { generate: async () => { called++; return { url: '/x.png' } }, now: NOW })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'need_subject')
  assert.equal(called, 0, '一次生成都不该发生')
  assert.ok(Array.isArray(r.questions) && r.questions.length >= 2)
  assert.match(r.questions[0], /主体/)
  assert.equal(readCommission(root, c.id).spent, 0)
})

test('有主体就放行，主体会进提示词', async () => {
  const root = ws()
  const c = createCommission(root, { title: 't', subject: '一颗悬空的白色陶瓷球', goal: '纯黑背景，细线', brief: { deliverables: ['A'] }, cap: 3 }, { now: NOW })
  let seen = ''
  const r = await runCommission(root, c.id, { generate: async ({ prompt }) => { seen = prompt; return { url: '/a.png' } }, now: NOW })
  assert.equal(r.ok, true)
  assert.match(seen, /白色陶瓷球/)
  assert.match(seen, /不出现任何文字/)
})

test('工具层：缺主体时不建单，改为把问题问回去', async () => {
  const root = ws()
  const exec = commissionExtraExecutors(root, { generate: async () => ({ url: '/a.png' }), now: () => NOW }).commission
  const res = await exec({ action: 'create', title: '空提示', goal: '极简', deliverables: ['A'] })
  assert.equal(res.isError, false)
  assert.match(res.text, /先别急着建单/)
  assert.ok(Array.isArray(res.needsClarification) && res.needsClarification.length)
  assert.equal(listCommissions(root).length, 0, '不该落库')
  // 用户坚持时 force 可以强行建单
  const forced = await exec({ action: 'create', title: '空提示', goal: '极简', deliverables: ['A'], force: true })
  assert.match(forced.text, /已创建委托/)
  assert.equal(listCommissions(root).length, 1)
})

test('formatCommission 一句话说清状态与额度', () => {
  const root = ws()
  const c = createCommission(root, { title: 'x', goal: 'g', cap: 4 }, { now: NOW })
  assert.match(formatCommission(c), /x · running · 已用 0\/4 点/)
})

test('交付件验活：文件拿不到就记失败，不写进"已完成"', async () => {
  const root = ws()
  const c = createCommission(root, { title: 't', subject: '测试主体', goal: 'g', brief: { deliverables: ['A', 'B'] }, cap: 5 }, { now: NOW })
  let i = 0
  const r = await runCommission(root, c.id, {
    generate: async () => ({ url: i++ === 0 ? '/api/ws/file?path=' + encodeURIComponent('missing.png') : '/ok.png' }),
    verify: async (url) => (String(url).includes('missing') ? { ok: false, reason: '文件不存在' } : { ok: true }),
    now: NOW,
  })
  assert.equal(r.report.files.length, 2, '两件都尝试过')
  assert.equal(r.report.files[0].verified, false)
  assert.equal(r.report.files[1].verified, true)
  assert.equal(r.report.unverified, 1)
  assert.match(r.report.errors[0].error, /拿不到|文件不存在/)
  assert.equal(r.ok, false)
})

test('验活本身：本地文件在不在、远端 HEAD 通了才算', async () => {
  const root = ws()
  const dir = path.join(root, '生成物')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'a.png'), Buffer.from('x'))
  assert.equal((await verifyArtifact('/api/ws/file?path=' + encodeURIComponent('生成物/a.png'), { wsRoot: root })).ok, true)
  assert.equal((await verifyArtifact('/api/ws/file?path=' + encodeURIComponent('生成物/没有.png'), { wsRoot: root })).ok, false)
  const okFetch = async () => ({ ok: true, status: 200 })
  assert.equal((await verifyArtifact('https://x.com/a.png', { fetchImpl: okFetch })).ok, true)
  const badFetch = async () => ({ ok: false, status: 404 })
  assert.equal((await verifyArtifact('https://x.com/a.png', { fetchImpl: badFetch })).ok, false)
})
