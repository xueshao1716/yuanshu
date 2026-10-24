#!/usr/bin/env node
// scripts/test-session.mjs —— 测试会话统一入口（2026-10-24）
//
// 教训：之前用"按内容匹配"的方式清理会话，把伙伴的真实会话（01a14ef1）当成测试会话挪进了 .trash。
// 从那以后定两条硬规矩：
//   1. 所有测试会话必须 **名字带 [真测]**、归 **test 分组**；
//   2. 清理只允许删 group=test 的会话，且必须显式 `--apply`（默认 dry-run）。
//
// 用法：
//   node scripts/test-session.mjs new "压缩自检"        # 建一条 [真测] 会话，打印 id
//   node scripts/test-session.mjs list                  # 列出 test 分组会话
//   node scripts/test-session.mjs clean [--apply]       # 清理 test 分组会话（默认只显示）
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const AGENT_DIR = process.env.YUANSHU_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent')
const TOKEN_FILE = process.env.YUANSHU_TOKEN_FILE || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Local', 'Programs', 'Yuanshu', 'app', '.token')
const BASE = process.env.YUANSHU_BASE || 'http://127.0.0.1:8787'

function token() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim() } catch {}
  return process.env.YUANSHU_TOKEN || ''
}

async function call(pathname, init = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  const text = await res.text()
  try { return { status: res.status, body: JSON.parse(text) } } catch { return { status: res.status, body: text } }
}

const cmd = process.argv[2] || 'help'
if (cmd === 'new') {
  const name = `[真测] ${process.argv[3] || new Date().toISOString().slice(11, 19)}`
  const r = await call('/api/sessions', { method: 'POST', body: JSON.stringify({ title: name, group: 'test' }) })
  if (r.status >= 400) { console.error('创建失败', r.status, r.body); process.exit(1) }
  console.log(JSON.stringify({ id: r.body.id, name, group: 'test' }, null, 2))
} else if (cmd === 'list') {
  const r = await call('/api/sessions')
  const list = (r.body?.sessions || []).filter((s) => s.group === 'test')
  console.log(`test 分组会话 ${list.length} 条`)
  for (const s of list) console.log(`  ${s.id}  ${s.name}  ${s.messageCount} 条  ${s.updatedAt}`)
} else if (cmd === 'clean') {
  const apply = process.argv.includes('--apply')
  const r = await call('/api/sessions')
  const list = (r.body?.sessions || []).filter((s) => s.group === 'test')
  console.log(`${apply ? '删除' : '将删除（dry-run）'} ${list.length} 条 test 分组会话`)
  for (const s of list) {
    console.log(`  ${s.id}  ${s.name}`)
    if (apply) {
      const d = await call(`/api/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' })
      console.log(`    → ${d.status}`)
    }
  }
  if (!apply) console.log('加 --apply 才会真的删。')
} else {
  console.log('用法: new <名字> | list | clean [--apply]')
}
