import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { createMiscApi } from '../../engine/misc-api.mjs'

test('review explicitly reports the file preview limit and total', async () => {
  const fx = fixture(os.tmpdir(), async args => ({ ok: true, output: args[0] === 'status'
    ? ['## main', ...Array.from({ length: 325 }, (_, i) => ` M file${i}.mjs`), ''].join('\0') : '' }));
  await fx.api.handleGitReview({});
  assert.equal(fx.response().body.files.length, 300);
  assert.equal(fx.response().body.filesTotal, 325);
  assert.equal(fx.response().body.filesTruncated, true);
});

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}

function fixture(cwd, gitRunner = null) {
  let response
  const api = createMiscApi({
    json: (_res, status, body) => { response = { status, body } },
    readJsonFile: () => ({}), writeJsonFile: () => true,
    getAgentDir: () => cwd, authPath: '', modelsPath: '',
    openSession: async () => null, ensureAgent: async () => {}, getDefaultModel: () => null,
    refreshModelList: async () => {}, scanSessionFiles: () => [], extractText: () => '', parseSessionFile: () => ({}),
    cwd, scanExclude: /(^|[\\/])node_modules([\\/]|$)/i,
    ...(gitRunner ? { gitRunner } : {}),
  })
  return { api, response: () => response }
}

test('git review returns branch, per-file counts, bounded diff, and truthful verification state', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'piweb-git-review-'))
  try {
    git(cwd, ['init', '-b', 'main'])
    git(cwd, ['config', 'user.email', 'test@example.com'])
    git(cwd, ['config', 'user.name', 'Test'])
    fs.writeFileSync(path.join(cwd, 'README.md'), 'before\n')
    git(cwd, ['add', 'README.md'])
    git(cwd, ['commit', '-m', 'initial'])
    fs.writeFileSync(path.join(cwd, 'README.md'), 'before\nafter\n')
    fs.writeFileSync(path.join(cwd, 'new.txt'), 'untracked\n')

    const fx = fixture(cwd)
    await fx.api.handleGitReview({})
    const result = fx.response()
    assert.equal(result.status, 200)
    assert.equal(result.body.isRepo, true)
    assert.equal(result.body.branch, 'main')
    assert.equal(result.body.files.some(file => file.path === 'README.md' && file.additions === 1 && file.deletions === 0), true)
    assert.equal(result.body.files.some(file => file.path === 'new.txt' && file.status === 'untracked'), true)
    assert.match(result.body.diff, /\+after/)
    assert.deepEqual(result.body.verification, { state: 'unknown', checks: [] })
    assert.equal(typeof result.body.diffTruncated, 'boolean')
  } finally { fs.rmSync(cwd, { recursive: true, force: true }) }
})

test('git review reports a non-repository without pretending verification ran', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'piweb-git-review-empty-'))
  try {
    const fx = fixture(cwd)
    await fx.api.handleGitReview({})
    assert.deepEqual(fx.response().body, {
      isRepo: false, branch: null, files: [], diff: '', diffTruncated: false,
      verification: { state: 'unknown', checks: [] },
    })
  } finally { fs.rmSync(cwd, { recursive: true, force: true }) }
})

test('git review reports oversized command output instead of inventing a changed file', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'piweb-git-review-large-'))
  try {
    const fx = fixture(cwd, async args => args[0] === 'status'
      ? { ok: false, isRepo: true, output: '', error: 'output_too_large' }
      : { ok: true, isRepo: true, output: '' })
    await fx.api.handleGitReview({})
    assert.deepEqual(fx.response().body, {
      isRepo: true, branch: null, files: [], diff: '', diffTruncated: false,
      error: 'output_too_large', verification: { state: 'unknown', checks: [] },
    })
  } finally { fs.rmSync(cwd, { recursive: true, force: true }) }
})

test('git review keeps a bounded diff preview when the repository diff exceeds the process buffer', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'piweb-git-review-diff-large-'))
  try {
    git(cwd, ['init', '-b', 'main'])
    git(cwd, ['config', 'user.email', 'test@example.com'])
    git(cwd, ['config', 'user.name', 'Test'])
    const before = 'a'.repeat(2_200_000) + '\n'
    const after = 'b'.repeat(2_200_000) + '\n'
    fs.writeFileSync(path.join(cwd, 'large.txt'), before)
    git(cwd, ['add', 'large.txt'])
    git(cwd, ['commit', '-m', 'initial'])
    fs.writeFileSync(path.join(cwd, 'large.txt'), after)

    const fx = fixture(cwd)
    await fx.api.handleGitReview({})
    const result = fx.response()
    assert.equal(result.status, 200)
    assert.equal(result.body.diffTruncated, true)
    assert.ok(result.body.diff.length > 0)
    assert.match(result.body.diff, /diff --git a\/large\.txt b\/large\.txt/)
  } finally { fs.rmSync(cwd, { recursive: true, force: true }) }
})

test('git review preserves Chinese and valid filenames that resemble shell fragments', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'piweb-git-review-noise-'))
  try {
    const fx = fixture(cwd, async args => {
      if (args[0] === 'status') return { ok: true, isRepo: true, output: ['## main', ' M 中文.md', '?? src/NaN.ts', '?? src/undefined.ts', '?? -p', '?? $null', ' M build/config.ts', '?? spaced name.txt', ''].join('\0') }
      if (args[0] === 'diff' && args.includes('--numstat')) return { ok: true, isRepo: true, output: '2\t1\t中文.md\0' }
      return { ok: true, isRepo: true, output: '' }
    })
    await fx.api.handleGitReview({})
    assert.deepEqual(fx.response().body.files.map(file => file.path), ['中文.md', 'src/NaN.ts', 'src/undefined.ts', '-p', '$null', 'build/config.ts', 'spaced name.txt'])
    assert.equal(fx.response().body.files[0].additions, 2)
  } finally { fs.rmSync(cwd, { recursive: true, force: true }) }
})

test('git review parses NUL-delimited renames and unusual path characters without losing records', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'piweb-git-review-shell-noise-'))
  try {
    const fx = fixture(cwd, async args => {
      if (args[0] === 'status') return {
        ok: true, isRepo: true,
        output: ['## main', 'R  新文件.md', '旧文件.md', ' M name\twith\nlines.txt', ' M after.ts', ''].join('\0'),
      }
      if (args[0] === 'diff' && args.includes('--numstat')) return { ok: true, isRepo: true, output: ['3\t2\t', '旧文件.md', '新文件.md', '1\t0\tname\twith\nlines.txt', '4\t0\tafter.ts', ''].join('\0') }
      return { ok: true, isRepo: true, output: '' }
    })
    await fx.api.handleGitReview({})
    assert.deepEqual(fx.response().body.files, [
      { path: '新文件.md', status: 'renamed', code: 'R ', additions: 3, deletions: 2 },
      { path: 'name\twith\nlines.txt', status: 'modified', code: ' M', additions: 1, deletions: 0 },
      { path: 'after.ts', status: 'modified', code: ' M', additions: 4, deletions: 0 },
    ])
  } finally { fs.rmSync(cwd, { recursive: true, force: true }) }
})

test('git review can inspect an explicit repository root independently from the workspace cwd', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'piweb-git-review-workspace-'))
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'piweb-git-review-repo-'))
  try {
    git(repo, ['init', '-b', 'main'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    git(repo, ['config', 'user.name', 'Test'])
    fs.writeFileSync(path.join(repo, 'app.ts'), 'export const value = 1\n')
    git(repo, ['add', 'app.ts'])
    git(repo, ['commit', '-m', 'initial'])
    fs.writeFileSync(path.join(repo, 'app.ts'), 'export const value = 2\n')
    fs.writeFileSync(path.join(workspace, 'noise.txt'), 'workspace noise\n')

    let explicitResponse
    const explicit = createMiscApi({
      json: (_res, status, body) => { explicitResponse = { status, body } },
      readJsonFile: () => ({}), writeJsonFile: () => true,
      getAgentDir: () => workspace, authPath: '', modelsPath: '',
      openSession: async () => null, ensureAgent: async () => {}, getDefaultModel: () => null,
      refreshModelList: async () => {}, scanSessionFiles: () => [], extractText: () => '', parseSessionFile: () => ({}),
      cwd: workspace, gitCwd: repo, scanExclude: /(^|[\\/])node_modules([\\/]|$)/i,
    })
    await explicit.handleGitReview({})
    assert.equal(explicitResponse.body.root, repo)
    assert.deepEqual(explicitResponse.body.files.map(file => file.path), ['app.ts'])
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
    fs.rmSync(repo, { recursive: true, force: true })
  }
})
