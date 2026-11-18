import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRestartGuard, LOOP_WINDOW_MS } from '../../engine/restart-guard.mjs'

test('上次启动自动续过又很快重启 → 熔断；没续过或隔得久 → 照常续', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-guard-'))
  try {
    const t0 = Date.parse('2026-11-18T10:00:00Z')
    assert.equal(createRestartGuard(dir, t0).allowAutoResume(), true, '首次启动')
    assert.equal(createRestartGuard(dir, t0 + 60_000).allowAutoResume(), true, '上次没自动续，快速重启也照常')
    createRestartGuard(dir, t0 + 120_000).markAutoResumed()
    const looped = createRestartGuard(dir, t0 + 180_000)
    assert.equal(looped.allowAutoResume(), false, '刚续过就重启：熔断')
    assert.equal(createRestartGuard(dir, t0 + 240_000).allowAutoResume(), true, '熔断那次没续，下次恢复')
    createRestartGuard(dir, t0 + 300_000).markAutoResumed()
    assert.equal(createRestartGuard(dir, t0 + 300_000 + LOOP_WINDOW_MS + 1).allowAutoResume(), true, '隔得够久不算循环')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
