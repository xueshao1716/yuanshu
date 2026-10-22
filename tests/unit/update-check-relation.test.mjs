// 在线更新检查：只有远端确实有本地没有的提交才提示「有更新」；本地领先（待推送）不能误报。
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkUpdate, relateCommits } from '../../engine/system-panel.mjs';

const LOCAL = 'aaaaaaa1111111111111111111111111111111111';
const fakeFetch = (sha) => async () => ({ ok: true, json: async () => ({ sha: sha + '0'.repeat(33), commit: { message: 'm\nbody', author: { date: '2026-10-05' } } }) });

// git 桩：按命令返回预设结果
function fakeGit({ known = true, ancestor = 'yes', ahead = '3' } = {}) {
  return (args) => {
    const [cmd] = args;
    if (cmd === 'rev-parse') return { ok: true, out: LOCAL };
    if (cmd === 'cat-file') return known ? { ok: true, out: '' } : { ok: false, code: 128 };
    if (cmd === 'merge-base') return ancestor === 'yes' ? { ok: true, out: '' } : ancestor === 'no' ? { ok: false, code: 1 } : { ok: false, code: 128 };
    if (cmd === 'rev-list') return { ok: true, out: ahead };
    return { ok: false, code: -1 };
  };
}

test('本地与远端一致 → 已是最新，relation=same', async () => {
  const r = await checkUpdate('.', undefined, { fetchImpl: fakeFetch('aaaaaaa'), git: fakeGit() });
  assert.equal(r.upToDate, true);
  assert.equal(r.relation, 'same');
});

test('本地领先（远端是本地祖先）→ 不提示更新，带领先提交数', async () => {
  const r = await checkUpdate('.', undefined, { fetchImpl: fakeFetch('bbbbbbb'), git: fakeGit({ ancestor: 'yes', ahead: '2' }) });
  assert.equal(r.upToDate, true);
  assert.equal(r.relation, 'ahead');
  assert.equal(r.ahead, 2);
});

test('远端提交本地没有 → 落后，提示更新', async () => {
  const r = await checkUpdate('.', undefined, { fetchImpl: fakeFetch('ccccccc'), git: fakeGit({ known: false }) });
  assert.equal(r.upToDate, false);
  assert.equal(r.relation, 'behind');
});

test('两边各有新提交 → 分叉，提示更新（不当成最新）', async () => {
  const r = await checkUpdate('.', undefined, { fetchImpl: fakeFetch('ddddddd'), git: fakeGit({ ancestor: 'no' }) });
  assert.equal(r.upToDate, false);
  assert.equal(r.relation, 'diverged');
});

test('git 判定出错 → unknown，保守提示更新', () => {
  assert.equal(relateCommits('.', 'eeeeeee', fakeGit({ ancestor: 'err' })).relation, 'unknown');
  assert.equal(relateCommits('.', '', fakeGit()).relation, 'unknown');
});

test('本地提交号不可读 → checkable=false，不判为最新', async () => {
  const git = (args) => args[0] === 'rev-parse' ? { ok: false, code: 128 } : { ok: true, out: '' };
  const r = await checkUpdate('.', undefined, { fetchImpl: fakeFetch('aaaaaaa'), git });
  assert.equal(r.checkable, false);
  assert.equal(r.upToDate, false);
});

test('真仓库：HEAD 相对自己的父提交是领先 1', () => {
  const r = relateCommits(process.cwd(), 'HEAD~1');
  assert.equal(r.relation, 'ahead');
  assert.equal(r.ahead, 1);
});
test('安装版：远端提交比本机构建旧 → 不提示更新（防止把降级当新版）', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
  fs.writeFileSync(path.join(dir, '.yuanshu-build.json'), JSON.stringify({ commit: LOCAL, builtAt: '2026-10-22T10:00:00Z' }), 'utf8');
  const fetchOld = async () => ({ ok: true, json: async () => ({ sha: 'bbbbbbb' + '0'.repeat(33), commit: { message: 'old', author: { date: '2026-10-20T10:00:00Z' } } }) });
  const git = (args) => args[0] === 'rev-parse' ? { ok: true, out: LOCAL } : { ok: true, out: '' };
  const r = await checkUpdate(dir, undefined, { fetchImpl: fetchOld, git });
  assert.equal(r.upToDate, true);
  assert.equal(r.relation, 'ahead');
  assert.equal(r.reason, 'remote-older');
});

test('安装版：远端提交比本机构建新 → 提示更新', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd2-'));
  fs.writeFileSync(path.join(dir, '.yuanshu-build.json'), JSON.stringify({ commit: LOCAL, builtAt: '2026-10-20T10:00:00Z' }), 'utf8');
  const fetchNew = async () => ({ ok: true, json: async () => ({ sha: 'ccccccc' + '0'.repeat(33), commit: { message: 'new', author: { date: '2026-10-22T10:00:00Z' } } }) });
  const git = (args) => args[0] === 'rev-parse' ? { ok: true, out: LOCAL } : { ok: true, out: '' };
  const r = await checkUpdate(dir, undefined, { fetchImpl: fetchNew, git });
  assert.equal(r.upToDate, false);
  assert.equal(r.relation, 'behind');
});