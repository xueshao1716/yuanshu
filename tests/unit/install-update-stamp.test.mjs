// 安装版更新后必须刷新构建标记（2026-10-18）。
// 真机现象：设置页一直提示「发现新版本」，当前版本停在安装当天的 SHA。
// 根因：.yuanshu-build.json 只在安装时写一次，reset --hard 更新完不刷新。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeBuildInfo, readBuildInfo, updateInstalledApp, BUILD_INFO } from '../../engine/install-update.mjs'

const SHA = 'abcdef0123456789abcdef0123456789abcdef01'

function tmpRoot(gitDir = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-upd-'))
  if (gitDir) fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true })
  return root
}

test('writeBuildInfo 只接受完整 40 位提交号', () => {
  const root = tmpRoot()
  assert.equal(writeBuildInfo(root, 'deadbeef').ok, false)
  assert.equal(writeBuildInfo(root, 'HEAD').ok, false)
  assert.equal(writeBuildInfo(root, SHA).ok, true)
  assert.equal(readBuildInfo(root).commit, SHA)
  assert.ok(readBuildInfo(root).builtAt)
})

test('更新成功后把标记对齐到新 HEAD', async () => {
  const root = tmpRoot()
  writeBuildInfo(root, '1'.repeat(40))
  const calls = []
  const git = async (args) => {
    calls.push(args.join(' '))
    if (args[0] === 'rev-parse') return { ok: true, out: SHA + '\n', err: '' }
    return { ok: true, out: '', err: '' }
  }
  const r = await updateInstalledApp({ root, git, npm: async () => ({ ok: true }) })
  assert.equal(r.ok, true)
  assert.equal(readBuildInfo(root).commit, SHA, '标记必须是更新后的 HEAD')
  assert.ok(calls.some(c => c.startsWith('reset')), '必须走过 reset')
})

test('reset 失败时不改标记（不能把没升成功的版本标成新的）', async () => {
  const root = tmpRoot()
  writeBuildInfo(root, '2'.repeat(40))
  const git = async (args) => {
    if (args[0] === 'fetch') return { ok: true, out: '', err: '' }
    if (args[0] === 'reset') return { ok: false, out: '', err: 'boom' }
    return { ok: true, out: '', err: '' }
  }
  const r = await updateInstalledApp({ root, git, npm: async () => ({ ok: true }) })
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'checkout')
  assert.equal(readBuildInfo(root).commit, '2'.repeat(40))
})

test('标记文件名保持约定', () => {
  assert.equal(BUILD_INFO, '.yuanshu-build.json')
})
