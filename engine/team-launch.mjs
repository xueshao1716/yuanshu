import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { reviewStoragePath, reviewAtomicWrite } from './review-file-safety.mjs';

// The launcher owns process admission; durable checkpoints own stage replay.
export function createTeamLauncher({ wsRoot, repoRoot, port, token, spawnProcess = spawn }) {
  const storage = name => reviewStoragePath(wsRoot, `记忆/运行时/${name}`);
  const claimPath = () => storage('天团启动锁.json');
  const statePath = () => storage('天团启动状态.json');
  const read = file => {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid record');
      return value;
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  };
  const alive = pid => {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid pid');
    try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; }
  };
  const persist = state => reviewAtomicWrite(statePath(), JSON.stringify(state));
  const snapshotMatches = id => {
    try { return read(reviewStoragePath(wsRoot, '工程/多AI角色扮演系统/team-run.json'))?.launchId === id; }
    catch { return false; }
  };
  let current;
  const liveChildren = new Set();
  function status() {
    try {
      const persisted = read(statePath());
      const state = persisted || current;
      const claim = read(claimPath());
      if (!state) return claim ? { status: 'blocked', note: '发现未确认的启动锁，请检查运行进程后处理' } : null;
      if (!['launching', 'running', 'stopping', 'stopped', 'completed', 'failed', 'interrupted'].includes(state.status)) throw new Error('invalid state');
      const result = { id: state.id, checkpointId: state.checkpointId || state.id, status: state.status, task: state.task, at: state.at, endedAt: state.endedAt, pid: state.pid, note: state.note,
        ...(state.binding?.runId ? { runId: state.binding.runId, sessionId: state.binding.sessionId } : {}) };
      if (!liveChildren.has(state.id) && (['running', 'stopping'].includes(state.status) && !alive(state.pid) || state.status === 'launching' && !alive(state.ownerPid))) {
        result.status = 'interrupted';
        result.note = '执行进程已不可确认；未自动重放，请检查启动锁';
      }
      return result;
    } catch { return { status: 'blocked', note: '启动记录不可安全读取，请检查运行时目录' }; }
  }
  async function start(task, checkpointId = null, binding = {}, onEvent = null) {
    if (typeof task !== 'string' || !task.trim() || task.length > 300 || /[\x00-\x1f]/.test(task)) return { status: 400, body: { error: '任务须为 1–300 字的单行文本' } };
    const state = { id: randomUUID(), checkpointId, binding, status: 'launching', task: task.trim(), at: new Date().toISOString(), ownerPid: process.pid };
    let claimed = false;
    const release = () => {
      if (read(claimPath())?.id !== state.id) throw new Error('claim owner changed');
      fs.unlinkSync(claimPath());
    };
    try {
      const old = read(storage('天团运行锁.json'));
      if (old && alive(old.pid)) return { status: 409, body: { error: '已有一趟天团在跑，请等待结束' } };
      const file = claimPath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state), { flag: 'wx' });
      claimed = true;
    } catch { return { status: 409, body: { error: '已有启动锁或锁文件不可安全读取，请先检查运行进程' } }; }
    try { persist(state); current = state; }
    catch {
      if (claimed) { try { release(); } catch {} }
      return { status: 500, body: { error: '无法保存启动状态，未启动任务' } };
    }
    return new Promise(resolve => {
      let child, settled = false, spawned = false, finished = false;
      const respond = code => {
        if (settled) return;
        settled = true;
        resolve({ status: code, body: code === 200 ? { ok: true, started: true, launch: status() } : { error: '天团启动失败，请检查运行状态', launch: status() } });
      };
      const finish = (kind, note) => {
        if (finished) return;
        finished = true;
        liveChildren.delete(state.id);
        Object.assign(state, { status: kind, note, endedAt: new Date().toISOString() });
        try { persist(state); release(); }
        catch { state.note = '状态保存或锁释放失败，请检查运行时目录'; }
      };
      try {
        child = spawnProcess(process.execPath, [path.join(repoRoot, 'scripts', 'team-run-live.mjs'), state.task], {
          cwd: wsRoot, detached: true, stdio: onEvent ? ['ignore', 'pipe', 'ignore'] : 'ignore', windowsHide: true, shell: false,
          env: { ...process.env, YUANSHU_CWD: wsRoot, YUANSHU_TOKEN: token,
            YUANSHU_TEAM_BASE_URL: `http://127.0.0.1:${port}`, YUANSHU_TEAM_LAUNCH_ID: state.id,
            YUANSHU_TEAM_RESUME_ID: checkpointId || '', YUANSHU_TEAM_RUN_ID: binding.runId || '',
            YUANSHU_TEAM_SESSION_ID: binding.sessionId || '', YUANSHU_TEAM_CONTEXT: binding.context || '',
            YUANSHU_TEAM_DIRECTIVE: binding.directive || '' },
        });
        let eventBuffer = '';
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', chunk => {
          eventBuffer += chunk;
          const lines = eventBuffer.split('\n'); eventBuffer = lines.pop().slice(-16000);
          for (const line of lines) {
            if (!line.startsWith('YUANSHU_TEAM_EVENT ')) continue;
            try {
              const event = JSON.parse(line.slice(19));
              if (['subagent_started', 'subagent_finished'].includes(event.type)) onEvent?.(event.type, event.data);
            } catch {}
          }
        });
        child.once('spawn', () => {
          if (finished) return;
          spawned = true;
          liveChildren.add(state.id);
          Object.assign(state, { status: 'running', pid: child.pid });
          try { persist(state); child.unref(); respond(200); }
          catch { state.note = '进程已启动但状态保存失败，请勿重复启动'; respond(500); }
        });
        child.on('error', () => {
          // After spawn an error does not prove the process exited: keep the claim.
          if (!spawned) finish('failed', '进程未能启动');
          else { state.note = '进程报告错误，等待退出确认'; try { persist(state); } catch {} }
          respond(500);
        });
        child.once('exit', (code, signal) => {
          if (fs.existsSync(storage(`team-stop-${state.id}.json`))) {
            finish('stopped', '已停止后续步骤；正在途中的远端调用可能仍计费，恢复前会检查不确定步骤');
            respond(500); return;
          }
          const complete = code === 0 && !signal && snapshotMatches(state.id);
          finish(complete ? 'completed' : 'failed', complete ? '执行已结束；草稿是否验收请查看待审区' : '进程异常退出或缺少本次结果，不视为完成');
          respond(500);
        });
      } catch { finish('failed', '进程未能启动'); respond(500); }
    });
  }
  function stop(id) {
    const state = status();
    if (!state || state.id !== id || !['running', 'launching', 'stopping'].includes(state.status)) return { status: 409, body: { error: '任务状态已变化，请刷新后重试' } };
    try {
      reviewAtomicWrite(storage(`team-stop-${id}.json`), JSON.stringify({ id, at: new Date().toISOString() }));
      const record = read(statePath());
      record.status = 'stopping'; record.note = '已请求停止，等待执行端确认';
      persist(record); current = record;
      return { status: 200, body: { ok: true, launch: status() } };
    } catch { return { status: 500, body: { error: '停止请求未保存，请刷新核对' } }; }
  }
  async function resume(id, onEvent = null) {
    const state = status();
    if (!state || state.id !== id || !['failed', 'stopped', 'interrupted'].includes(state.status)) return { status: 409, body: { error: '当前任务不可恢复，请刷新核对' } };
    try {
      const claim = read(claimPath());
      if (claim) {
        const record = read(statePath());
        if (claim.id !== id || alive(record.pid || record.ownerPid)) throw new Error('owner not confirmed dead');
        fs.unlinkSync(claimPath());
      }
      return start(state.task, state.checkpointId || id, read(statePath()).binding || {}, onEvent);
    } catch { return { status: 409, body: { error: '无法确认原进程已退出，未重放任务' } }; }
  }
  return { start, status, stop, resume };
}
