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
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const DETACHED_DIR = "bg-jobs";
export const DONE_MARK = "__DONE__";
/** 日志尾巴最多读这么多字节：日志可能是几 MB（渲染器会刷帧），不能整份读进内存。 */
export const LOG_TAIL_BYTES = 8192;

/**
 * 作业目录（.cmd / .log / .json 落盘处）必须是**纯 ASCII 路径**。
 * 实测（2026-10-25）：把 .cmd 放在 `记忆\运行时\后台进程\` 下，`cmd.exe /c` 根本找不到它——
 * WMI 返回 pid、进程瞬间退出、日志一个字节都没有；换成 ASCII 目录后同一条命令立刻成功。
 * 所以这里按顺序挑第一个 ASCII 目录：工作区 bg-jobs → ProgramData → TEMP → USERPROFILE；
 * 全都不行才如实报错（别假装启动成功）。
 * 注意：这只解决「脚本文件放哪」；脚本**内容**里的中文路径由 buildCmdFile 的 UTF-8 BOM 解决。
 */
export function isAsciiPath(p) {
  return /^[\x20-\x7E]*$/.test(String(p || ""));
}

export function pickBaseDir(wsRoot) {
  // 2026-10-26：优先**用户级** LOCALAPPDATA，而不是机器级 ProgramData。
  // 作业目录只是运行期草稿（.cmd/.log/.json），不该写到 C:\ProgramData 这种系统级位置；
  // LOCALAPPDATA 是每用户、免管理员、通常纯 ASCII，符合 Windows 惯例。
  const candidates = [
    process.env.YUANSHU_BG_JOBS_DIR || "",
    path.join(String(wsRoot || "."), DETACHED_DIR),
    path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "C:\\Users\\Public", "AppData", "Local"), "Yuanshu", DETACHED_DIR),
    path.join(process.env.ProgramData || "C:\\ProgramData", "Yuanshu", DETACHED_DIR),
    path.join(process.env.USERPROFILE || "C:\\Users\\Public", "Yuanshu", DETACHED_DIR),
    // 临时目录放最后——安全软件常在 %TEMP% 拦 .cmd，cmd.exe 会起不来。
    path.join(process.env.TEMP || process.env.TMP || "C:\\Windows\\Temp", "Yuanshu", DETACHED_DIR),
  ];
  // 2026-10-26 真机：工作区本身在 %TEMP% 下时（测试用 mkdtemp 建的临时工作区），
  // 第一个候选就是 TEMP —— 作业脚本落在那儿，WMI 拉起 cmd.exe 会返回
  // 0x800700E8（232 ERROR_NO_DATA）。所以**任何落在 TEMP 里的候选都跳过**。
  const tmpRoots = [process.env.TEMP, process.env.TMP, "C:\\Windows\\Temp"]
    .filter(Boolean)
    .map((t) => String(t).replace(/\\/g, "/").toLowerCase());
  const inTemp = (c) => {
    const n = String(c).replace(/\\/g, "/").toLowerCase();
    return tmpRoots.some((t) => n === t || n.startsWith(t + "/")) || /\/appdata\/local\/temp(\/|$)/i.test(n);
  };
  for (const c of candidates) {
    if (!c || !isAsciiPath(c)) continue;
    if (inTemp(c)) continue;
    return c;
  }
  return "";
}

function dirOf(wsRoot) { return pickBaseDir(wsRoot); }
function newId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`; }

/**
 * 生成启动脚本。单独成文件是为了避开多层引号地狱（cmd → powershell → WMI）。
 *
 * 2026-10-25 真事故补丁：.cmd 里写着中文（cwd / command 指向含中文的工作区）时，
 * cmd.exe 按**系统 ANSI 代码页**（中文机是 GBK）解析整份脚本。我们写的是 UTF-8，
 * 于是 `cd /d "D:\我的工作区"` 被读成乱码目录 → cd 失败 → 命令在错目录里跑 → 退出码 1。
 * 两条修法同时上：
 *   ① 文件带 UTF-8 BOM，并在开头 `chcp 65001`，让 cmd.exe 明确按 UTF-8 读脚本；
 *   ② 断言：内容要么带 BOM、要么整份纯 ASCII —— 两个都不满足就拒绝启动（别假装成功）。
 */
/** 取 8.3 短路径（把中文路径变成 ASCII）。取不到就返回空串。 */
export function shortPathOf(target) {
  try {
    const out = execFileSync("cmd.exe", ["/c", `for %I in ("${String(target).replace(/"/g, "")}") do @echo %~sI`], {
      encoding: "utf8", timeout: 15000, windowsHide: true,
    }).trim();
    return /^[\x20-\x7e]+$/.test(out) ? out : "";
  } catch { return ""; }
}

export function buildCmdFile({ command, cwd, logPath }) {
  // 2026-10-26 真机教训：.cmd **不能**带 UTF-8 BOM。
  // cmd.exe 会把 BOM 当成首行命令的一部分，首行解析失败 → 后面的都不执行，
  // 日志 0 字节、WMI 却照样返回 pid，上层只能看到「启动失败」。
  // （注意：.ps1 的规则相反，**需要** BOM。）
  const safeCwd = isAsciiPath(cwd) ? String(cwd) : shortPathOf(cwd);
  const lines = [
    "@echo off",
    // 切到 UTF-8 代码页：命令输出里的中文用 UTF-8 写日志，读回来不乱码
    "chcp 65001 > nul",
    `cd /d "${String(safeCwd || cwd).replace(/"/g, "")}"`,
    `${command} >> "${logPath}" 2>&1`,
    `echo ${DONE_MARK} %ERRORLEVEL% >> "${logPath}"`,
  ];
  return lines.join("\r\n") + "\r\n";
}

/**
 * 断言启动脚本是「UTF-8 BOM」或「纯 ASCII」二者之一。
 * 两者都不满足时 cmd.exe 会按 ANSI 代码页误读中文路径，作业会静默失败（退出码 1）——
 * 所以宁可在这里如实拒绝，也不要写出去赌一把。
 * @returns {{ok:boolean, encoding:"utf8-bom"|"ascii"|"", reason?:string}}
 */
export function assertCmdSafe(content) {
  const text = String(content || "");
  // 2026-10-26：.cmd 里出现 BOM 是**错误**（首行会解析失败、整份脚本不执行）。
  if (text.charCodeAt(0) === 0xFEFF) {
    return { ok: false, encoding: "", reason: ".cmd 不能带 UTF-8 BOM：cmd.exe 会把 BOM 当成首行命令的一部分，导致整份脚本不执行" };
  }
  // 注意：这里要判的是「整份脚本内容是否纯 ASCII」，不能用 isAsciiPath——
  // 那个是给路径用的白名单，会把引号、重定向符、百分号误判成非 ASCII。
  if (!/[^\x20-\x7e\r\n\t]/.test(text)) return { ok: true, encoding: "ascii" };
  return { ok: false, encoding: "", reason: "启动脚本含非 ASCII 字符（中文路径/命令）——请改用 8.3 短路径，或把工作区放到纯 ASCII 目录" };
}

/**
 * 清理旧作业文件（默认 7 天）。作业目录是运行期草稿，不是归档——
 * 不清理会一直堆积（真机：一次测试就几十个文件）。
 */
export function pruneOldJobs({ wsRoot, maxAgeMs = 7 * 86400 * 1000, now = Date.now() } = {}) {
  const dir = dirOf(wsRoot);
  if (!dir) return { removed: 0 };
  let removed = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(cmd|log|json|launch|out)$/.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        if (now - st.mtimeMs > maxAgeMs) { fs.rmSync(file, { force: true }); removed += 1 }
      } catch {}
    }
  } catch {}
  return { removed };
}

/**
 * 清掉旧的机器级作业目录（`C:\ProgramData\Yuanshu`）。
 *
 * 为什么由服务做：那是 SYSTEM 属主，普通用户删不掉；服务本身以 SYSTEM 运行，
 * 启动时顺手清掉最省事。只在"当前作业目录不在它下面"时才删，避免误删正在用的。
 */
export function cleanupLegacyJobDir({ currentBase, legacy = "C:\\ProgramData\\Yuanshu", now = Date.now() } = {}) {
  if (!fs.existsSync(legacy)) return { removed: false, reason: "not_exists" };
  const cur = String(currentBase || "").replace(/\\/g, "/").toLowerCase();
  const old = String(legacy).replace(/\\/g, "/").toLowerCase();
  if (cur && cur.startsWith(old)) return { removed: false, reason: "in_use" };
  try {
    fs.rmSync(legacy, { recursive: true, force: true });
    return { removed: true, at: now };
  } catch (e) {
    return { removed: false, reason: String(e?.message || e).slice(0, 120) };
  }
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
    const cmdText = buildCmdFile({ command: cmd, cwd, logPath });
    // 断言：.cmd 必须是 UTF-8 BOM 或纯 ASCII，否则 cmd.exe 会把中文路径读成乱码
    const safe = assertCmdSafe(cmdText);
    if (!safe.ok) return { ok: false, error: safe.reason };
    fs.writeFileSync(cmdFile, cmdText, "utf8");
    fs.writeFileSync(logPath, "", "utf8");
  } catch (e) { return { ok: false, error: `写启动脚本失败：${String(e?.message || e).slice(0, 120)}` }; }

  let pid = 0;
  try {
    // WMI 创建：进程归属 WmiPrvSE，逃出本服务的 Job Object
    // 2026-10-26：WMI 默认会**弹出可见的 cmd 窗口**（用户反馈"一直弹窗"）。
    // 用 ProcessStartupInformation 把 ShowWindow 置 0，进程照样跑，但不闪黑窗。
    const ps = [
      "$ErrorActionPreference='Stop'",
      "$si = New-CimInstance -ClassName Win32_ProcessStartup -Namespace root/cimv2 -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd.exe /c "${cmdFile}"'; ProcessStartupInformation = $si }`,
      "if ($r.ReturnValue -ne 0) { Write-Output ('ERR:' + $r.ReturnValue); exit 1 }",
      "Write-Output $r.ProcessId",
    ].join("; ");
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      encoding: "utf8", timeout: 30_000, windowsHide: true,
    }).trim();
    pid = Number((out.match(/(\d+)\s*$/) || [])[1]) || 0;
  } catch (e) {
    // 2026-10-26：WMI 报 0x800700E8（232 ERROR_NO_DATA）时，多半是安全软件拦了 .cmd，
    // 或临时目录里的文件在启动瞬间不可用。降级用 spawn 直接拉起（在服务进程树内，
    // 服务重启会被带走），至少不让作业完全起不来，并记录用的是哪种方式。
    const raw = String(e?.message || e);
    const hint = /0x800700e8/i.test(raw) || /\b232\b/.test(raw)
      ? "（232 ERROR_NO_DATA：目标在启动瞬间不可用，常见于安全软件拦 .cmd 或临时目录）"
      : "";
    try {
      const child = spawn("cmd.exe", ["/c", cmdFile], { cwd, detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
      pid = child.pid || 0;
      if (!pid) return { ok: false, error: `WMI 启动失败${hint}，降级 spawn 也没拿到 pid：${raw.slice(0, 140)}` };
      try { fs.writeFileSync(path.join(dir, `${id}.launch`), JSON.stringify({ via: "spawn-fallback", pid, at: Date.now(), wmiError: raw.slice(0, 200) }), "utf8"); } catch {}
    } catch (e2) {
      return { ok: false, error: `WMI 启动失败${hint}，降级也失败：${String(e2?.message || e2).slice(0, 140)}` };
    }
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
    // 2026-10-26：把真实开始时间带出去——list 要按它排序，页面也要显示
    startedAt: Number(meta.startedAt) || null,
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
  } catch (e) {
    // 进程可能在我们探活之后、taskkill 之前自己结束了（渲染跑完就属于这种情况）。
    // 这时 taskkill 会报"没有找到进程"——不该把它当成停止失败，再探一次活就够。
    const again = readDetached({ wsRoot, id });
    if (again.ok && !again.alive) return { ok: true, alreadyStopped: true, id };
    return { ok: false, error: String(e?.message || e).slice(0, 160) };
  }
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
  // 2026-10-26：按开始时间倒序。原来按 elapsedMs 排，作业目录共享时（ProgramData）
  // 刚起的作业可能被挤出 limit 之外——列出来的不是「最近」的。
  rows.sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0));
  return rows.slice(0, Math.max(1, limit));
}
