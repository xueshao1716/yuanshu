import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { collectSessionFiles } from '../../engine/session-files.mjs'
import { environmentSection } from '../../engine/runtime-env.mjs'
import { buildYuanshuSections } from '../../engine/yuanshu-prompt.mjs'

test('collectSessionFiles：递归子目录，跳过 .trash 与归档', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'))
  fs.mkdirSync(path.join(root, '--D--ws--'), { recursive: true })
  fs.mkdirSync(path.join(root, '.trash'), { recursive: true })
  fs.writeFileSync(path.join(root, '--D--ws--', 'a.jsonl'), '{}\n')
  fs.writeFileSync(path.join(root, '--D--ws--', 'b.jsonl'), '{}\n')
  fs.writeFileSync(path.join(root, 'root.jsonl'), '{}\n')
  fs.writeFileSync(path.join(root, '--D--ws--', 'c.archive.jsonl'), '{}\n')
  fs.writeFileSync(path.join(root, '.trash', 'd.jsonl'), '{}\n')
  const files = collectSessionFiles(root)
  assert.equal(files.length, 3, `应为 3（子目录 2 + 根 1），实际 ${files.length}`)
  assert.ok(files.every((f) => !/\.archive\.jsonl$/.test(f) && !f.includes('.trash')))
})

test('环境段：声明真实平台与 shell，且明确路径符号规则', () => {
  const text = environmentSection()
  assert.match(text, /【运行环境】/)
  assert.match(text, /Windows|git-bash|cmd|POSIX/)
  assert.match(text, /路径|path/i)
  // 必须提醒"别用 WSL 路径"或"用 Windows 绝对路径"之一
  assert.ok(/\/mnt\/d|Windows 绝对路径/.test(text), '应给出路径符号规则')
})

test('prompt 组装：environment 段出现在协议段之前', () => {
  const sections = buildYuanshuSections({})
  assert.ok(sections.environment, '应自动注入 environment 段')
  const assembled = Object.keys(sections)
  assert.ok(assembled.includes('environment'))
})
