// ===== detached-run.mjs —— 脱链运行长任务（2026-10-25）=====
//
// 起因（真事故）：2026-10-25 13:45 小语启动了一次 45 秒影片渲染（om.js + Chrome + ffmpeg）。
// 渲染本身 6 分钟后成功产出 12.28MB 视频，但我中途 `sc stop` 重启服务部署新版本，
// 她的 run 记录里留下 `error: "server_restarted"`——**外部作业跟着服务一起死了**，
// 而且她为了等它，在单轮里 sleep 90 / sleep 120，把单轮执行预算等光，轮次被自动暂停。
//
// 两条修法都在这里：
//   ① 脱链：用 WMI（Win32_Process.Create）启动进程。创建者是 WmiPrvSE.exe，
//     **不在本服务的 Windows Job Object 里**，所以服务重启/被杀不会连带它。
//     这也解释了为什么她用了 `nohup` 没用——nohup 只管 SIGHUP，管不了 Job Object。
//   ② 不等：start 立刻返回 pid + 日志路径；下一轮用 status 查一次（读日志尾巴 + 探活），
//     不再用 sleep 在单轮里干等。
//
// 落盘：<wsRoot>/记忆/运行时/后台进程/<id>.{cmd,log,json}
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const DETACHED_DIR = "bg-jobs";
export const DONE_MARK = "__DONE__";
/** 日志尾巴最多读这么多字节：日志可能是几 MB（渲染器会刷帧），不能整份读进内存。 */
export const LOG_TAIL_BYTES = 8192;

/**
 * 作业目录必须是**纯 ASCII 路径**。
 * 实测（2026-10-25）：把 .cmd 放在 `记忆\运行时\后台进程\` 下，`cmd.exe /c` 根本找不到它——
 * WMI 返回 pid、进程瞬间退出、日志一个字节都没有；换成 ASCII 目录后同一条命令立刻成功。
 * 所以这里先选 ASCII 目录，选不到就换 ProgramData，都不行就如实报错（别假装启动成功）。
 */
export function isAsciiPath(p) {
  return /^[\x20-\x7E]*$/.test(String(p || ""));
}

export function pickBaseDir(wsRoot) {
  const primary = path.join(String(wsRoot || "."), DETACHED_DIR);
  if (isAsciiPath(primary)) return primary;
  const programData = process.env.ProgramData || "C:\\ProgramData";
  const fallback = path.join(programData, "Yuanshu", DETACHED_DIR);
  if (isAsciiPath(fallback)) return fallback;
  return "";
}

function dirOf(wsRoot) { return pickBaseDir(wsRoot); }
function newId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`; }

/** 生成启动脚本。单独成文件是为了避开多层引号地狱（cmd → powershell → WMI）。 */
export function buildCmdFile({ command, cwd, logPath }) {
  const lines = [
    "@echo off",
    `cd /d "${String(cwd).replace(/"/g, "")}"`,
    `${command} >> "${logPath}" 2>&1`,
    `echo ${DONE_MARK} %ERRORLEVEL% >> "${logPath}"`,
  ];
  return lines.join("\r\n") + "\r\n";
}

/** 读日志尾巴（不整份读）。 */
export function readLogTail(logPath, { bytes = LOG_TAIL_BYTES } = {}) {
  try {
    const st = fs.statSync(logPath);
    const start = Math.max(0, st.size - bytes);
    const fd = fs.openSync(logPath, "r");
    const buf = Buffer.alloc(st.size - start);
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
    return buf.toString("utf8");
  } catch { return ""; }
}

/** 从日志尾巴判断是否已经跑完，以及退出码。 */
export function parseDone(tail) {
  const m = String(tail || "").match(new RegExp(`${DONE_MARK}\\s+(-?\\d+)`));
  if (!m) return { done: false, exitCode: null };
  return { done: true, exitCode: Number(m[1]) };
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * 启动一个脱链进程。
 * @returns {{ok:boolean, id?:string, pid?:number, logPath?:string, error?:string}}
 */
export function launchDetached({ wsRoot, command, cwd = process.cwd(), label = "job" } = {}) {
  const cmd = String(command || "").trim();
  if (!cmd) return { ok: false, error: "空命令" };
  const id = newId();
  const dir = dirOf(wsRoot);
  if (!dir) return { ok: false, error: "找不到可用的 ASCII 作业目录（工作区路径含中文，且 ProgramData 也不可用）——脱链启动会静默失败，这里如实拒绝" };
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const logPath = path.join(dir, `${id}.log`);
  const cmdFile = path.join(dir, `${id}.cmd`);
  try {
    fs.writeFileSync(cmdFile, buildCmdFile({ command: cmd, cwd, logPath }), "utf8");
    fs.writeFileSync(logPath, "", "utf8");
  } catch (e) { return { ok: false, error: `写启动脚本失败：${String(e?.message || e).slice(0, 120)}` }; }

  let pid = 0;
  try {
    // WMI 创建：进程归属 WmiPrvSE，逃出本服务的 Job Object
    const ps = [
      "$ErrorActionPreference='Stop'",
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd.exe /c "${cmdFile}"' }`,
      "if ($r.ReturnValue -ne 0) { Write-Output ('ERR:' + $r.ReturnValue); exit 1 }",
      "Write-Output $r.ProcessId",
    ].join("; ");
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      encoding: "utf8", timeout: 30_000, windowsHide: true,
    }).trim();
    pid = Number((out.match(/(\d+)\s*$/) || [])[1]) || 0;
  } catch (e) {
    return { ok: false, error: `WMI 启动失败：${String(e?.message || e).slice(0, 160)}` };
  }

  try {
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
      id, label, command: cmd, cwd, pid: pid || null, logPath, cmdFile, startedAt: Date.now(),
    }, null, 2), "utf8");
  } catch {}

  return { ok: true, id, pid: pid || null, logPath };
}

/** 查一个脱链进程：活着吗、跑完没、退出码、日志尾巴。 */
export function readDetached({ wsRoot, id } = {}) {
  const dir = dirOf(wsRoot);
  const metaPath = path.join(dir, `${String(id || "")}.json`);
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch { return { ok: false, error: "找不到这个后台作业" }; }
  const tail = readLogTail(meta.logPath);
  const { done, exitCode } = parseDone(tail);
  const alive = !done && isAlive(meta.pid);
  return {
    ok: true,
    id: meta.id,
    label: meta.label,
    pid: meta.pid,
    command: meta.command,
    elapsedMs: Date.now() - (Number(meta.startedAt) || Date.now()),
    alive,
    done,
    exitCode,
    // 只回尾巴：调用方要细节自己去读文件，别把几 MB 日志塞进对话
    logTail: tail.slice(-2000),
    logPath: meta.logPath,
  };
}

export function stopDetached({ wsRoot, id } = {}) {
  const info = readDetached({ wsRoot, id });
  if (!info.ok) return info;
  if (!info.alive) return { ok: true, alreadyStopped: true, id };
  try {
    execFileSync("taskkill.exe", ["/PID", String(info.pid), "/T", "/F"], { stdio: "ignore", timeout: 20_000, windowsHide: true });
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 160) }; }
  return { ok: true, killed: true, id, pid: info.pid };
}

/** 列最近的脱链作业（按启动时间倒序）。 */
export function listDetached({ wsRoot, limit = 10 } = {}) {
  const dir = dirOf(wsRoot);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return []; }
  const rows = [];
  for (const n of names) {
    const info = readDetached({ wsRoot, id: n.replace(/\.json$/, "") });
    if (info.ok) rows.push(info);
  }
  rows.sort((a, b) => (b.elapsedMs || 0) < (a.elapsedMs || 0) ? -1 : 1);
  return rows.slice(0, Math.max(1, limit));
}
