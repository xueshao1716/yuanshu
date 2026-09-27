// Shared project context for standalone team runs.
// Context lives under <workspace>/工程/<project>/{context.md,context.json}.
import fs from 'node:fs'
import path from 'node:path'
import { defaultWorkspace } from '../engine/workspace-default.mjs'
import { reviewStoragePath } from '../engine/review-file-safety.mjs'
import { readReviewBounded } from '../engine/review-read.mjs'

const WS = path.resolve(process.env.YUANSHU_CWD || process.env.PI_WEB_CWD || process.env.PI_WORKSPACE || defaultWorkspace())
const ROOT = path.join(WS, '工程')

function projects() {
  try { return fs.readdirSync(ROOT, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) } catch { return [] }
}

function readContext(name) {
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') return { name, md: '', json: null }
  const mdPath = reviewStoragePath(WS, `工程/${name}/context.md`)
  const jsonPath = reviewStoragePath(WS, `工程/${name}/context.json`)
  const read = file => {
    try { return readReviewBounded(file, 512 * 1024).toString('utf8').trim() }
    catch (e) { if (e.code === 'ENOENT') return ''; throw e }
  }
  const out = { name, md: read(mdPath), json: null }
  const rawJson = read(jsonPath)
  if (rawJson) { try { out.json = JSON.parse(rawJson) } catch {} }
  return out
}

export function contextBlock(name) {
  const context = readContext(name)
  if (!context.md && !context.json) return ''
  const parts = [`【项目上下文 · ${name}】（每次开工前先读，跨文档保持一致）`]
  if (context.md) parts.push(context.md)
  if (context.json) {
    const format = value => Array.isArray(value) ? value.join('；') : JSON.stringify(value)
    if (context.json.characters) parts.push('角色：' + format(context.json.characters))
    if (context.json.glossary) parts.push('术语：' + format(context.json.glossary))
    if (context.json.taboos) parts.push('禁忌：' + format(context.json.taboos))
    if (context.json.exports) parts.push('交付标准：' + format(context.json.exports))
  }
  return parts.join('\n')
}

export function guessProject(task) {
  return projects().find(name => (fs.existsSync(path.join(ROOT, name, 'context.md')) || fs.existsSync(path.join(ROOT, name, 'context.json'))) && String(task || '').includes(name)) || ''
}

const argv = process.argv.slice(2)
if (argv[0] === '--list') {
  const rows = projects().filter(name => fs.existsSync(path.join(ROOT, name, 'context.md')) || fs.existsSync(path.join(ROOT, name, 'context.json')))
  console.log(rows.length ? rows.map(name => '  · ' + name).join('\n') : '（还没有任何项目写 context.md）')
} else if (argv[0] === '--show') {
  const block = contextBlock(argv[1] || '')
  console.log(block || `（${argv[1] || '该项目'} 还没有 context.md）`)
} else if (argv[0] === '--compose') {
  const block = contextBlock(argv[1] || '')
  console.log([block, '【任务】' + argv.slice(2).join(' ')].filter(Boolean).join('\n\n'))
}
