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
