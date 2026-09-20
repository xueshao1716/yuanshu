import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

test('NSIS build launcher parses and starts its hidden child script', { skip: process.platform !== 'win32' }, () => {
  const launcher = new URL('../../app/run-nsis-build.ps1', import.meta.url)
  const child = new URL('../../app/nsis-build-child.ps1', import.meta.url)
  const launcherText = fs.readFileSync(launcher, 'utf8')
  const childText = fs.readFileSync(child, 'utf8')
  const android = new URL('../../app/run-android-build.ps1', import.meta.url)
  for (const file of [launcher, child, android]) {
    const scriptPath = fileURLToPath(file).replace(/'/g, "''")
    const command = `$ErrorActionPreference='Stop'; $tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile('${scriptPath}',[ref]$tokens,[ref]$errors)|Out-Null; if($errors.Count){throw ($errors|Out-String)}`
    execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { stdio: 'pipe' })
  }
  assert.match(launcherText, /-File.*\$child/)
  assert.ok(childText.includes('--bundles nsis --ci'))
  assert.ok(childText.includes('$build.WaitForExit()'), 'Wait for the compiler process directly; PS5 job waiting can hang after NSIS exits')
  // 代理变量重名（NO_PROXY/no_proxy）会让 PS5.1 的 Start-Process 抛错，构建一两秒就退出。
  // 桌面这条链必须点源共享的去重脚本——缺了它，构建会在真正开始前就死掉（2026-09-20 撞过）。
  assert.match(childText, /ps-env-dedupe\.ps1/, 'nsis-build-child.ps1 必须先点源 ps-env-dedupe.ps1');
})

test('NSIS build treats compiler stderr as output and only delivers the current version', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-build-'))
  const app = path.join(root, 'app with spaces')
  const workspace = path.join(root, 'workspace')
  const bundles = path.join(workspace, '.build-cache/cargo/release/bundle/nsis')
  try {
    fs.mkdirSync(path.join(app, 'node_modules/.bin'), { recursive: true })
    fs.mkdirSync(path.join(app, 'src-tauri'), { recursive: true })
    fs.mkdirSync(bundles, { recursive: true })
    fs.copyFileSync(new URL('../../app/nsis-build-child.ps1', import.meta.url), path.join(app, 'nsis-build-child.ps1'))
    // 子脚本会点源同目录的去重脚本：孤零零放一个 child 是跑不起来的，夹具要带上它
    fs.copyFileSync(new URL('../../app/ps-env-dedupe.ps1', import.meta.url), path.join(app, 'ps-env-dedupe.ps1'))
    fs.writeFileSync(path.join(app, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: '0.2.4', productName: '元枢' }))
    fs.writeFileSync(path.join(app, 'node_modules/.bin/tauri.cmd'), '@echo off\r\necho compiler warning 1>&2\r\nexit /b 0\r\n')
    fs.writeFileSync(path.join(bundles, '元枢_0.2.4_x64-setup.exe'), 'MZcurrent')
    fs.writeFileSync(path.join(bundles, '元枢_0.2.2_x64-setup.exe'), 'MZold')
    const stale = new Date(Date.now() + 60000)
    fs.utimesSync(path.join(bundles, '元枢_0.2.2_x64-setup.exe'), stale, stale)
    try {
      // 故意同时塞大小写两份代理变量：这正是 2026-09-20 真机上把构建卡死的那种环境
      // （PS5.1 的 Start-Process 复制环境块时抛"已添加项"）。有了 ps-env-dedupe.ps1 才跑得下去。
      const env = { ...process.env, PI_WORKSPACE: workspace, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' }
      execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(app, 'nsis-build-child.ps1')], { env, stdio: 'pipe' })
    } catch (error) {
      const logs = ['tauri-build.log', 'tauri-build-stderr.log'].map(name => {
        const file = path.join(app, name)
        if (!fs.existsSync(file)) return name + ': absent'
        const bytes = fs.readFileSync(file)
        return name + ': ' + bytes.toString(bytes[0] === 255 ? 'utf16le' : 'utf8')
      })
      throw new Error(logs.join('\n'), { cause: error })
    }
    assert.equal(fs.readFileSync(path.join(app, 'tauri-build.exit'), 'utf8').trim(), '0')
    const delivered = path.join(workspace, '交付/元枢桌面客户端')
    assert.deepEqual(fs.readdirSync(delivered), ['元枢_0.2.4_x64-setup.exe'])
    assert.equal(fs.readFileSync(path.join(delivered, '元枢_0.2.4_x64-setup.exe'), 'utf8'), 'MZcurrent')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
