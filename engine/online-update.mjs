// Online update orchestration; command execution is injectable for isolated verification.
import path from 'node:path';
import { execFile } from 'node:child_process';
import { json } from './http-utils.mjs';

const GIT_NO_PROXY = ['-c', 'http.proxy=', '-c', 'https.proxy='];
function execute(file, args, options) {
  return new Promise(resolve => {
    execFile(file, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      resolve({ ok: !error, out: String(stdout || '').trim(),
        err: error ? String(stderr || error.message).trim().slice(-500) : '' });
    });
  });
}

export function createUpdateHandler({ root, platform = process.platform, execute: run = execute,
  scheduleRestart = () => setTimeout(() => process.exit(0), 1500),
}) {
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
      if (body?.engine) {
        const engine = await npm(['install', '-g', '@earendil-works/pi-coding-agent@latest'], root);
        if (!engine.ok) return json(res, 500, { error: '引擎升级失败: ' + engine.err });
        messages.push('引擎已升级');
      }
      const fetched = await git(['fetch', 'origin']);
      if (!fetched.ok) return json(res, 500, { error: 'fetch 失败: ' + fetched.err });
      const pulled = await git(['pull', '--ff-only', 'origin', 'main']);
      if (!pulled.ok) return json(res, 409, { error: '拉取失败: ' + pulled.err + '（请检查本地改动或分支冲突）' });
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
