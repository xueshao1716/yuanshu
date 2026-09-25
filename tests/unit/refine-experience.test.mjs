import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initRefineApi, handleRefineStatus } from '../../engine/refine-api.mjs'

test('refine exposes searchable experience headings with source and read failure distinct from absence', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-refine-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  initRefineApi({ cwd: root })
  const file = path.join(root, '工程', '经验库', 'experience.md')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Array.from({ length: 10 }, (_, i) => `## 经验${i}\n观察，不代表已验证\n`).join(''))
  let data
  const res = { writeHead() {}, end: raw => { data = JSON.parse(raw) } }
  handleRefineStatus(res)
  assert.equal(data.experience.entries.length, 10)
  assert.equal(data.experience.source, '工程/经验库/experience.md')
  fs.unlinkSync(file); fs.mkdirSync(file)
  handleRefineStatus(res)
  assert.equal(data.experience.error, 'experience_unreadable')
})
