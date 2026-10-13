// Online update orchestration; command execution is injectable for isolated verification.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { json } from './http-utils.mjs';
import { isInstalledApp, updateInstalledApp } from './install-update.mjs';
import { createUpdateRestart } from './update-restart.mjs';

const GIT_NO_PROXY = ['-c', 'http.proxy=', '-c', 'https.proxy='];
function execute(file, args, options) {
  return new Promise(resolve => {
    execFile(file, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      resolve({ ok: !error, out: String(stdout || '').trim(),
        err: error ? String(stderr || error.message).trim().slice(-500) : '' });
    });
  });
}


/** 分叉自愈：把本地未提交改动+独立提交留档快照，然后 reset --hard 对齐 origin/main。
 *  红线：快照失败绝不 reset（宁可保持现状让人工介入）。 */
export async function reconcileDiverged({ git, root, fsMod = fs }) {
  const ymd = new Date().toISOString().slice(0, 10);
  let snapshotDir = '';
  for (const cand of [`E:\yuanshu-archive\backups\${ymd}-pre-update-diff`, path.join(process.env.USERPROFILE || process.env.HOME || '/', '.yuanshu-snapshots', `${ymd}-pre-update-diff`)]) {
    try { fsMod.mkdirSync(cand, { recursive: true }); snapshotDir = cand; break; } catch { }
  }
  if (!snapshotDir) return { ok: false, error: '找不到可用快照目录' };
  // 1) 未提交改动 → patch
  const diff = await git(['diff', 'HEAD']);
  if (diff.ok && diff.out) fsMod.writeFileSync(path.join(snapshotDir, 'uncommitted.patch'), diff.out, 'utf8');
  // 2) 未跟踪文件清单 → 列表存档（不拷贝内容，只留名）
  const untracked = await git(['ls-files', '--others', '--exclude-standard']);
  if (untracked.ok && untracked.out) fsMod.writeFileSync(path.join(snapshotDir, 'untracked-files.txt'), untracked.out, 'utf8');
  // 3) 本地独立提交（不在远端的）→ patch 快照
  const ahead = await git(['log', '--oneline', 'origin/main..HEAD']);
  if (ahead.ok && ahead.out) {
    const patch = await git(['format-patch', 'origin/main..HEAD', '--stdout']);
    if (patch.ok && patch.out) fsMod.writeFileSync(path.join(snapshotDir, 'local-commits.patch'), patch.out, 'utf8');
    if (patch.ok) fsMod.writeFileSync(path.join(snapshotDir, 'local-commits.txt'), ahead.out, 'utf8');
  }
  // 4) 远端修正：旧仓名兜底（gitee pi-web → yuanshu，8-31 改名后有旧 clone 未跟进）
  const urls = await git(['remote', 'get-url', 'origin']);
  if (urls.ok && /gitee\.com\//.test(urls.out) && /\/pi-web(\.git)?$/.test(urls.out.trim())) {
    const fixed = urls.out.trim().replace(/\/pi-web(\.git)?$/, '/yuanshu.git');
    await git(['remote', 'set-url', 'origin', fixed]);
    const refetch = await git(['fetch', 'origin']);
    if (!refetch.ok) return { ok: false, error: '修正旧仓名后 fetch 仍失败: ' + refetch.err, snapshotPath: snapshotDir };
  }
  // 5) 对齐
  const reset = await git(['reset', '-q', '--hard', 'origin/main']);
  if (!reset.ok) return { ok: false, error: 'reset 失败: ' + reset.err, snapshotPath: snapshotDir };
  return { ok: true, snapshotPath: snapshotDir, fixedRemote: /pi-web/.test(urls.out || '') };
}

export function createUpdateHandler({ root, platform = process.platform, execute: run = execute,
  scheduleRestart, updateSources,
}) {
  // 2026-10-07 真机：更新后服务没起来。默认退出前确认有守护，没有就先拉一个（见 update-restart.mjs）。
  scheduleRestart ??= createUpdateRestart({ root, log: m => console.log(m) });
  let busy = false;
  const git = args => run('git', ['-C', root, ...GIT_NO_PROXY, ...args], { cwd: root, timeout: 60000, windowsHide: true });
  // Only fixed internal arguments enter cmd.exe; never interpolate request data.
  const npm = (args, cwd) => run(platform === 'win32' ? 'cmd.exe' : 'npm',
    platform === 'win32' ? ['/d', '/s', '/c', `npm ${args.join(' ')}`] : args,
    { cwd, timeout: 300000, windowsHide: true });
  return async function handleUpdateApply(res, body) {
    if (busy) return json(res, 409, { error: '已有更新进行中或正在等待重启，请勿重复操作' });
    busy = true;
    let restartScheduled = false;
    try {
      const messages = [];
      // 安装版的引擎在 runtime/node 里，npm -g 会装到别处还以为成功了，这里不接
      if (body?.engine && !isInstalledApp(root)) {
        const engine = await npm(['install', '-g', '@earendil-works/pi-coding-agent@latest'], root);
        if (!engine.ok) return json(res, 500, { error: '引擎升级失败: ' + engine.err });
        messages.push('引擎已升级');
      }
      // 安装版：app/ 没有 .git、没有前端源码，走稀疏浅仓库那条路
      if (isInstalledApp(root)) {
        const r = await updateInstalledApp({ root, git, npm, ...(updateSources ? { sources: updateSources } : {}) });
        if (!r.ok) return json(res, r.stage === 'fetch' ? 502 : 500, { stage: r.stage, codeUpdated: !!r.codeUpdated, restartScheduled: false, error: r.error });
        messages.push('程序已更新，来源 ' + new URL(r.source).hostname);
        json(res, 200, { ok: true, message: `更新成功（${messages.join(' + ')}），服务重启中…（约 10 秒）` });
        scheduleRestart();
        restartScheduled = true;
        return;
      }
      const fetched = await git(['fetch', 'origin']);
      if (!fetched.ok) return json(res, 500, { error: 'fetch 失败: ' + fetched.err });
      const pulled = await git(['pull', '--ff-only', 'origin', 'main']);
      if (!pulled.ok) {
        // 分叉自愈（2026-10-13 bug 弹窗实证）：本地与远端分叉时不再躺平报错——
        // 按伙伴「破坏操作先快照」的约定：本地 diff/提交 dump 进 E 盘存档，然后 reset --hard 对齐 origin/main。
        const healed = await reconcileDiverged({ git, root });
        if (!healed.ok) {
          return json(res, 409, { error: '拉取失败（本地分叉，且自动恢复未成功）: ' + (healed.error || pulled.err) +
            '（请把 ' + (healed.snapshotPath || '本地快照') + ' 留档后手动 git reset --hard origin/main）' });
        }
        messages.push('本地分叉已自动快照并重置对齐远端（快照: ' + healed.snapshotPath + '）');
      }
      // Do not use npm ci against a running service: it removes node_modules first.
      // --no-save preserves the committed manifests/lockfile; install uses their locked versions.
      for (const [label, cwd] of [['服务端', root], ['前端', path.join(root, 'frontend')]]) {
        const installed = await npm(['install', '--no-save', '--no-audit', '--no-fund', '--include=dev'], cwd);
        if (!installed.ok) return json(res, 500, {
          stage: 'dependencies', codeUpdated: true, restartScheduled: false,
          error: `${label}依赖安装失败，源码已拉取但未重启，请修复依赖后重试: ${installed.err}`,
        });
      }
      messages.push('源码及依赖已更新');
      json(res, 200, { ok: true, message: `更新成功（${messages.join(' + ')}），服务重启中…（约 10 秒）` });
      scheduleRestart();
      restartScheduled = true;
    } catch (error) {
      json(res, 500, { error: '更新失败，未安排重启: ' + String(error?.message || error) });
    } finally {
      if (!restartScheduled) busy = false;
    }
  };
}
