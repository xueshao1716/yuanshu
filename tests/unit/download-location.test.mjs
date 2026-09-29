import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { isDesktopShellEnvironment } from '../../frontend/src/lib/download-location.ts'

test('download location detects desktop shells but not browser or mobile shells', () => {
  assert.equal(isDesktopShellEnvironment('http://127.0.0.1:8787', 'Mozilla/5.0 Windows NT 10.0', true), true)
  assert.equal(isDesktopShellEnvironment('http://127.0.0.1:8787', 'Mozilla/5.0 Windows NT 10.0', false), false)
  assert.equal(isDesktopShellEnvironment('https://pi.example.com', 'Mozilla/5.0 Android 14', true), false)
  assert.equal(isDesktopShellEnvironment('tauri://localhost', 'Mozilla/5.0 Windows NT 10.0', true), true)
})

test('downloads page exposes the native folder action and shell command', () => {
  const page = fs.readFileSync(new URL('../../frontend/src/pages/Downloads.tsx', import.meta.url), 'utf8')
  const shell = fs.readFileSync(new URL('../../app/src-tauri/src/lib.rs', import.meta.url), 'utf8')
  assert.match(page, /openDownloadFolder/)
  assert.match(page, /打开系统下载目录/)
  assert.match(shell, /open_download_folder/)
  assert.match(shell, /download_dir\(\)/)
})
