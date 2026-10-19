// 后台调研（2026-10-19）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildQueries, parseBingHtml, rankSources, runResearch, listResearch, readResearch, isRelevant } from '../../engine/design-research.mjs'

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), 'research-'))

const BING_HTML = `<ol id="b_results">
<li class="b_algo"><h2><a href="https://www.behance.net/gallery/1" target="_blank">Poster <strong>Design</strong> 案例</a></h2><p>poster design 极简海报案例集，含排版与留白分析。</p></li>
<li class="b_algo"><h2><a href="https://baike.baidu.com/item/minimal">minimal_百度百科</a></h2><p>词语释义。</p></li>
<li class="b_algo"><h2><a href="https://www.zcool.com.cn/x">海报设计 poster design 站酷</a></h2><p>poster design 参考。</p></li>
<li class="b_algo"><h2><a href="javascript:void(0)">ads</a></h2></li>
</ol>`

test('解析 Bing 结果：抽标题/链接/站点/摘要，跳过非 http 与广告', () => {
  const rows = parseBingHtml(BING_HTML, 5)
  assert.equal(rows.length, 3)
  assert.equal(rows[0].site, 'behance.net')
  assert.match(rows[0].title, /Poster Design 案例/, '标签要被剥掉')
  assert.ok(rows[0].snippet.includes('极简海报'))
})

test('相关性过滤：只含查询词的噪声会被丢掉', () => {
  const rows = parseBingHtml(BING_HTML, 5)
  const kept = rows.filter((r) => isRelevant(r, 'poster design'))
  assert.equal(kept.length, 2, '百科与广告不相关，应被过滤')
  assert.ok(kept.every((r) => /poster|design/i.test(`${r.title} ${r.snippet}`)))
})

test('查询组最多三条，空主题不出查询', () => {
  assert.equal(buildQueries('双11 主视觉').length, 3)
  assert.deepEqual(buildQueries('   '), [])
})

test('站点权重：设计站优先，百科降权', () => {
  const ranked = rankSources([
    { site: 'baike.baidu.com', title: 'a', url: 'https://baike.baidu.com/x', snippet: '短' },
    { site: 'behance.net', title: 'b', url: 'https://behance.net/x', snippet: '这是一段足够长的摘要内容，用来触发长度加权。' },
  ])
  assert.equal(ranked[0].site, 'behance.net')
})

test('跑一次调研：去重、落盘、可回读', async () => {
  const root = ws()
  let calls = 0
  const fetchImpl = async () => { calls++; return { ok: true, text: async () => BING_HTML } }
  const { ok, record } = await runResearch(root, { topic: 'poster design', fetchImpl, now: () => Date.parse('2026-10-19T15:00:00Z') })
  assert.equal(ok, true)
  assert.equal(calls, 3, '三组查询各一次')
  assert.equal(record.sources.length, 2, '跨查询按 url 去重（同一份结果重复三遍）')
  assert.equal(record.status, 'done')
  assert.match(record.report, /# 调研：poster design/)
  const files = fs.readdirSync(path.join(root, '记忆', '运行时', '调研'))
  assert.ok(files.some((f) => f.endsWith('.json')))
  assert.equal(readResearch(root, record.id)?.id, record.id)
  assert.equal(listResearch(root).length, 1)
})

test('取不到相关结果时如实说清楚原因（不清零冒充成功）', async () => {
  const root = ws()
  const junk = `<li class="b_algo"><h2><a href="https://baike.baidu.com/item/x">字典条目</a></h2><p>无关内容</p></li>`
  const fetchImpl = async () => ({ ok: true, text: async () => junk })
  const { ok, record } = await runResearch(root, { topic: '双11 美妆 主视觉', fetchImpl })
  assert.equal(ok, false)
  assert.equal(record.status, 'empty')
  assert.equal(record.sources.length, 0)
  assert.match(record.error, /没返回相关结果|网络出口|API_KEY/)
})

test('搜索全挂也不崩：状态 empty/failed 且报告可读', async () => {
  const root = ws()
  const broken = async () => { throw new Error('network down') }
  const { ok, record } = await runResearch(root, { topic: 'x', fetchImpl: broken })
  assert.equal(ok, false)
  assert.equal(record.sources.length, 0)
  assert.match(record.report, /没取到结果|调研：x/)
})
