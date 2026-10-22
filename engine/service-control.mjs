// engine/service-control.mjs —— 守护形态与状态（2026-10-22）
//
// 元枢有两种守护形态：
//   1) Windows 服务 YuanShuService（首选：无窗口、注销后仍在跑）
//   2) 计划任务 yuanshu-watchdog（回退：无需管理员）
// 这里只做"看状态 + 发起控制"，不自己实现守护逻辑（守护仍在 watchdog.cjs）。
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const SERVICE_NAME = 'YuanShuService';
export const TASK_NAME = 'yuanshu-watchdog';

async function sh(file, args, timeout = 8000) {
  try {
    const { stdout, stderr } = await run(file, args, { timeout, windowsHide: true });
    return { ok: true, out: `${stdout || ''}${stderr || ''}` };
  } catch (e) {
    return { ok: false, out: `${e?.stdout || ''}${e?.stderr || ''}`, code: e?.code };
  }
}

/** 服务是否已安装 + 状态（STOPPED/RUNNING/START_PENDING…） */
export async function serviceState() {
  if (process.platform !== 'win32') return { installed: false, state: 'unsupported' };
  const r = await sh('sc.exe', ['query', SERVICE_NAME]);
  if (!r.ok) {
    // 1060 = 服务不存在
    return { installed: false, state: 'absent', detail: String(r.out || '').slice(0, 200) };
  }
  const state = (r.out.match(/STATE\s*:\s*\d+\s+(\w+)/) || [])[1] || 'unknown';
  const pid = (r.out.match(/PID\s*:\s*(\d+)/) || [])[1] || '';
  return { installed: true, state, pid };
}

/** 计划任务状态（回退形态） */
export async function taskState() {
  if (process.platform !== 'win32') return { installed: false, state: 'unsupported' };
  const r = await sh('schtasks.exe', ['/query', '/tn', TASK_NAME, '/fo', 'list']);
  if (!r.ok) return { installed: false, state: 'absent' };
  const status = (r.out.match(/Status:\s*(\w+)/i) || [])[1] || 'unknown';
  return { installed: true, state: status };
}

/** 汇总：优先报服务，否则报任务 */
export async function watchdogStatus() {
  const svc = await serviceState();
  if (svc.installed) return { mode: 'service', name: SERVICE_NAME, ...svc };
  const task = await taskState();
  if (task.installed) return { mode: 'task', name: TASK_NAME, ...task };
  return { mode: 'none', state: 'absent' };
}

const ALLOWED = new Set(['start', 'stop', 'restart']);

/**
 * 控制守护。注意：stop/restart 会把服务本身（以及这个进程）停掉，
 * 所以调用方应先回响应，再用 detached 进程异步执行。
 */
export function controlCommand(action) {
  if (!ALLOWED.has(action)) return null;
  if (action === 'start') return { file: 'sc.exe', args: ['start', SERVICE_NAME] };
  if (action === 'stop') return { file: 'sc.exe', args: ['stop', SERVICE_NAME] };
  // restart：等 stop 完成再 start，串在一个 cmd 里跑
  return { file: 'cmd.exe', args: ['/c', `sc stop ${SERVICE_NAME} & ping -n 4 127.0.0.1 > nul & sc start ${SERVICE_NAME}`] };
}

/** 异步执行控制命令（不等待）：停服务会掐断当前请求，必须先返回再动手 */
export function runDetached({ file, args }) {
  const p = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
  p.unref();
  return true;
}
