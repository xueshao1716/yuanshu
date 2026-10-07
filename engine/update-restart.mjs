// 2026-10-07 真机：另一台电脑在线更新成功，服务退出后再没起来——那台机器的服务不在守护之下
// （安装版启动器加载守护时守护没启动；或手动/客户端直接起的 server）。退出前先确认有守护，没有就拉一个再退。
import net from 'node:net';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';

export const WATCHDOG_SINGLETON_PORT = 48787;

export function watchdogAlive({ port = WATCHDOG_SINGLETON_PORT, timeoutMs = 800 } = {}) {
  return new Promise(resolve => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = ok => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

export function createUpdateRestart({ root, alive = watchdogAlive, spawn = nodeSpawn, exit = code => process.exit(code),
  delayMs = 1500, log = () => {}, execPath = process.execPath, env = process.env } = {}) {
  return async function scheduleRestart() {
    let guarded = false;
    try { guarded = await alive(); } catch {}
    if (!guarded) {
      try {
        const child = spawn(execPath, [path.join(root, 'watchdog.cjs')], { cwd: root, env, detached: true, stdio: 'ignore', windowsHide: true });
        child.unref?.();
        log('[更新] 没有守护在跑，已拉起 watchdog 负责重启');
      } catch (e) { log(`[更新] 拉起 watchdog 失败：${e?.message || e}`); }
    }
    setTimeout(() => exit(0), delayMs);
    return { guarded };
  };
}
