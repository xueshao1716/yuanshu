import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { buildSelfModel } from '../../engine/self-model.mjs'

function makeWorld() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'self-model-'))
  const sessions = path.join(tmp, '.pi', 'agent', 'sessions')
  fs.mkdirSync(path.join(sessions, '--D--ws--'), { recursive: true })
  fs.mkdirSync(path.join(sessions, '.trash'), { recursive: true })
  // 真实会话（在子目录里，这正是以前漏数的位置）
  fs.writeFileSync(path.join(sessions, '--D--ws--', 'a.jsonl'), '{}\n')
  fs.writeFileSync(path.join(sessions, '--D--ws--', 'b.jsonl'), '{}\n')
  // 根目录残留（老口径只数这些）
  fs.writeFileSync(path.join(sessions, 'old.jsonl'), '{}\n')
  // 不该计入：归档副本、回收站
  fs.writeFileSync(path.join(sessions, '--D--ws--', 'c.archive.jsonl'), '{}\n')
  fs.writeFileSync(path.join(sessions, '.trash', 'd.jsonl'), '{}\n')
  return tmp
}

test('会话计数：递归统计子目录，跳过归档与回收站（2026-10-24 修的口径）', () => {
  const world = makeWorld()
  const prev = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME }
  process.env.USERPROFILE = world
  process.env.HOME = world
  try {
    const model = buildSelfModel({ wsRoot: world })
    // 子目录 2 段 + 根目录 1 段 = 3；归档副本（c.archive.jsonl）与 .trash 里的不算
    assert.equal(model.sessions, 3, `应数到 3 段（含根目录遗留），实际 ${model.sessions}`)
  } finally {
    if (prev.USERPROFILE === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = prev.USERPROFILE
    if (prev.HOME === undefined) delete process.env.HOME
    else process.env.HOME = prev.HOME
  }
})

test('会话计数：多候选目录累加去重（2026-11-06 新口径）', () => {
  // 构造：~/.pi/agent/sessions 有 2 段，wsRoot/sessions 有 1 段，互不重叠
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'self-model-multi-'))
  const homeSessions = path.join(tmp, 'home', '.pi', 'agent', 'sessions')
  const wsSessions = path.join(tmp, 'ws', 'sessions')
  fs.mkdirSync(path.join(homeSessions, '--D--pi-web--'), { recursive: true })
  fs.writeFileSync(path.join(homeSessions, '--D--pi-web--', 's1.jsonl'), '{}\n')
  fs.writeFileSync(path.join(homeSessions, '--D--pi-web--', 's2.jsonl'), '{}\n')
  fs.mkdirSync(wsSessions, { recursive: true })
  fs.writeFileSync(path.join(wsSessions, 's3.jsonl'), '{}\n')
  // wsRoot 下 .pi/agent/sessions 为空（第三候选路径）

  const prev = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME }
  process.env.USERPROFILE = path.join(tmp, 'home')
  process.env.HOME = path.join(tmp, 'home')
  try {
    const model = buildSelfModel({ wsRoot: path.join(tmp, 'ws') })
    // home 2 + ws 1 = 3（去重后各不重叠）
    assert.equal(model.sessions, 3, `应数到 3 段（home 2 + ws 1），实际 ${model.sessions}`)
  } finally {
    if (prev.USERPROFILE === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = prev.USERPROFILE
    if (prev.HOME === undefined) delete process.env.HOME
    else process.env.HOME = prev.HOME
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
