// engine/update-rollback.mjs —— 在线更新回滚（2026-10-12 伙伴要求："我们的更新不是每次都那么优秀"）
// 契约：每次 update/apply 动代码前先 recordPreUpdate 记下"上一个好版本"；
// 之后 /api/update/rollback 可一键 reset 回去（依赖重装+安全重启），失败就停在原地不动。
// install 版第一次更新时会被 install-update.git init 一个稀疏仓库，所以两种安装形态都能用 git reset --hard。
import fs from 'node:fs';
import path from 'node:path';
import { json } from './http-utils.mjs';
import { readBuildInfo } from './install-update.mjs';

const STATE_FILE = '.yuanshu-update-state.json';

export function statePath(root) { return path.join(root, STATE_FILE); }
export function readUpdateState(root) {
  try { return JSON.parse(fs.readFileSync(statePath(root), 'utf8')); } catch { return null; }
}

/** 在 apply 动代码前调用：记住"现在这个版本"（git 仓库用 HEAD；安装版用构建时写下的提交号）。 */
export function recordPreUpdate(root, git) {
  try {
    let previousSha = '', kind = 'git';
    if (git) {
      const r = git(['-C', root, 'rev-parse', 'HEAD']);
      previousSha = r.ok ? String(r.out || '').trim() : '';
    }
    if (!previousSha) previousSha = String(readBuildInfo(root)?.commit || '');
    if (readBuildInfo(root)) kind = 'install';
    if (!/^[0-9a-f]{40}$/.test(previousSha)) return null; // 既没有 .git 也没有构建提交号：没有可信锚点，拒绝留档
    const existing = readUpdateState(root);
    const previousAlready = existing && existing.previousSha === previousSha; // 同一节点的重复更新不覆盖首次记录
    if (!previousAlready) {
      fs.writeFileSync(statePath(root), JSON.stringify({
        previousSha, kind, recordedAt: new Date().toISOString(),
        previousVersion: new Date().toISOString().slice(0, 19),
      }, null, 1));
    }
    return readUpdateState(root);
  } catch { return null; }
}

/**
 * 回滚编排：reset 到留档提交 → 只重装生产依赖 → 安全重启。
 * 与 apply 相同的执行器/守护注入，进程不负责重启细节。
 */
const defaultRestart = (root) => async () => {
    const { createUpdateRestart } = await import('./update-restart.mjs');
    const fn = createUpdateRestart({ root, log: m => console.log(m) });
    return fn();
  };

export function createRollbackHandler({ root, platform = process.platform, execute, scheduleRestart = defaultRestart(root) }) {
  const GIT_NO_PROXY = ['-c', 'http.proxy=', '-c', 'https.proxy='];
  const npm = (args, cwd) => execute(platform === 'win32' ? 'cmd.exe' : 'npm',
    platform === 'win32' ? ['/d', '/s', '/c', `npm ${args.join(' ')}`] : args,
    { cwd, timeout: 300000, windowsHide: true });
  const busyRef = { v: false };
  return async function handleRollback(res) {
    if (busyRef.v) return json(res, 409, { error: '已有更新/回滚进行中，请勿重复操作' });
    const state = readUpdateState(root);
    if (!state || !/^[0-9a-f]{40}$/.test(String(state.previousSha || ''))) {
      return json(res, 409, { error: '没有可回滚的留档（回滚锚点会在下一次更新前自动记录）' });
    }
    busyRef.v = true;
    let restartScheduled = false;
    try {
      const git = (args) => execute('git', ['-C', root, ...GIT_NO_PROXY, ...args], { cwd: root, timeout: 60000, windowsHide: true });
      const reset = await git(['reset', '-q', '--hard', state.previousSha]);
      if (!reset.ok) return json(res, 500, { error: '回到上一版本失败: ' + String(reset.err).slice(-300) });
      const dirs = [root, path.join(root, 'frontend'), path.join(root, 'mcp-server')]
        .filter(dir => fs.existsSync(path.join(dir, 'package')));
      const messages = [];
      for (const dir of dirs) {
        const packages = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        void packages;
        const installArgs = dir.endsWith('frontend') ? ['install', '--no-save', '--no-audit', '--no-fund', '--include=dev']
          : ['install', '--omit=dev', '--no-save', '--no-audit', '--no-fund'];
        const r = await npm(installArgs, dir);
        if (!r.ok) return json(res, 500, { error: `依赖重装失败（${dir}）：${
          String(r.err).slice(-300)}` });
        messages.push(path.basename(dir) === dir ? '工作区' : path.basename(dir) === 'frontend' ? '前端' : 'mcp');
      }
      json(res, 200, { ok: true, message: `已回到上一版本 ${state.previousSha.slice(0, 7)}，服务重启中…（约 10 秒）` });
      scheduleRestart();
      restartScheduled = true;
      // 回滚成功后清掉锚点：现在"上一版本"就是它自己，避免连环回滚歧义
      try { fs.rmSync(statePath(root), { force: true }); } catch {}
    } catch (error) {
      json(res, 500, { error: '回滚失败: ' + String(error?.message || error).slice(0, 200) });
    } finally { if (!restartScheduled) busyRef.v = false; }
  };
}
