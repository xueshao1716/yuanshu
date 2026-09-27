// 元枢循环稳法（对照 Goose 空回合 / 截断 tool JSON，OpenHands 工具硬中止）
import { execFile } from "node:child_process";

export const MAX_EMPTY_TURN_RETRIES = 3;
export const EMPTY_TURN_ERROR = "模型空回复，已重试仍无正文";
// 2026-09-16 改文案：旧文案把锅甩给用户（"请把任务拆小"），而真因是**我们自己的输出预算太低**
// （写死 8192，而模型声明 32k~384k）。现在预算按模型声明给、截断时还会自动往上抬，
// 所以这条错误意味着"抬到头仍写不完这一轮"，到这时"分块写"才是对的建议。
export const TRUNCATED_TOOL_ERROR = "模型输出连续截断：已自动尝试分块接续，仍未收到完整响应。已保留完成的工具结果，未执行半截工具参数。";

export function isEmptyAssistantTurn({ text = "", hasTools = false } = {}) {
  return !hasTools && !String(text || "").trim();
}

export function emptyTurnDecision(emptyCount) {
  const n = Number(emptyCount) || 0;
  return n < MAX_EMPTY_TURN_RETRIES ? "retry" : "exhausted";
}

function repairArgs(s) {
  if (typeof s !== "string" || !s) return s;
  try { JSON.parse(s); return s; } catch {}
  let out = s;
  while (/^\{\s*\}\s*(?=\{)/.test(out)) out = out.replace(/^\{\s*\}\s*/, "");
  try { JSON.parse(out); return out; } catch { return s; }
}

export function inspectToolCalls(rawTcs) {
  if (!Array.isArray(rawTcs) || !rawTcs.length) return { calls: [], truncated: false };
  const calls = [];
  let truncated = false;
  for (const tc of rawTcs) {
    if (!tc || typeof tc !== "object" || !tc.function || typeof tc.function !== "object" || !tc.function.name) {
      truncated = true;
      continue;
    }
    const repaired = repairArgs(String(tc.function.arguments ?? "{}"));
    try {
      JSON.parse(repaired || "{}");
      calls.push({
        id: tc.id,
        type: "function",
        function: { name: tc.function.name, arguments: repaired || "{}" },
      });
    } catch {
      truncated = true;
    }
  }
  return { calls, truncated };
}

export function abortError() {
  const err = new Error("aborted");
  err.killed = true;
  err.aborted = true;
  err.code = "ABORT_ERR";
  return err;
}

// 2026-09-16：Windows 上 child.kill() 只杀**直接子进程**。工具命令是经 `bash -lc` / `cmd /c` 起的，
// 真正干活的那条命令是孙子进程——只杀 shell 会让它变孤儿继续跑（真机把 abort 用例从 <8s 拖成
// 30s 超时；界面上"停止"也停不干净）。
//
// 只靠 taskkill /T 也不够：git-bash 的 bin\bash.exe 是**启动器**，它会再 re-exec 出 usr\bin\bash.exe，
// 而 taskkill 枚举进程树和这个 fork 之间有竞态——实测 3 次里漏 1 次，漏掉的真 bash 攥着 cwd 不放
// （临时目录连 rmSync 都 EPERM）。所以再补一把"先快照、后从深到浅逐个点名"的扫尾：
// CIM 里的 ParentProcessId 即使父进程已经死了也还在，所以哪怕快照晚于 taskkill，孤儿照样能顺藤摸到。
const WIN_TREE_SWEEP = (pid) => [
  `$root=${pid}`,
  "$procs=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId",
  "$map=@{}",
  "foreach($p in $procs){$k=[int]$p.ParentProcessId;$c=[int]$p.ProcessId;if($map.ContainsKey($k)){$map[$k]+=@($c)}else{$map[$k]=@($c)}}",
  "$frontier=@($root);$level=0;$ordered=@()",
  "while($frontier.Count -gt 0 -and $level -lt 32){$next=@();foreach($q in $frontier){$ordered+=[pscustomobject]@{Id=$q;L=$level};if($map.ContainsKey([int]$q)){$next+=$map[[int]$q]}};$frontier=$next;$level++}",
  "$ordered|Sort-Object L -Descending|ForEach-Object{Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue}",
].join(";");

function killProcessTree(child) {
  if (!child || typeof child.pid !== "number") return;
  if (process.platform !== "win32") {
    try { child.kill("SIGKILL"); } catch {}
    return;
  }
  try {
    execFile("taskkill", ["/T", "/F", "/PID", String(child.pid)], () => {
      // taskkill 走完之后再补一刀直接子进程；树杀成功时这一刀是 ESRCH，无害。
      try { child.kill(); } catch {}
    });
  } catch {
    try { child.kill(); } catch {}
  }
  try {
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", WIN_TREE_SWEEP(child.pid)], () => {});
  } catch {}
}

export function execFileAbortable(file, args = [], options = {}) {
  const { signal, ...rest } = options;
  return new Promise((resolve, reject) => {
    let settled = false;
    let onAbort = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      try { if (onAbort) signal?.removeEventListener?.("abort", onAbort); } catch {}
      fn(value);
    };
    if (signal?.aborted) {
      settle(reject, abortError());
      return;
    }
    const child = execFile(file, args, rest, (err, stdout, stderr) => {
      // abort 时**不等子进程的管道关闭**：bash 起的孙子进程会攥着 stdout 句柄，
      // 等 close 事件就等于等命令自己跑完（实测 30s）。树杀在 onAbort 里已经发出，
      // 这里只负责让 promise 立刻落地。
      if (signal?.aborted || err?.killed) {
        const e = err || abortError();
        e.killed = true;
        e.aborted = true;
        settle(reject, e);
        return;
      }
      settle(resolve, { stdout, stderr, exitCode: err?.code ?? 0 });
    });
    onAbort = () => {
      settle(reject, abortError());
      killProcessTree(child);
    };
    try { signal?.addEventListener?.("abort", onAbort, { once: true }); } catch {}
  });
}
