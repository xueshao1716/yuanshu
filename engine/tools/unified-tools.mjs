// ===== unified-tools.mjs —— 统一工具集（schema + 执行器，从 server.mjs 抽离）=====
// 大脑可移植的关键一步：工具不再长在 HTTP 服务里。
// server.mjs 通过 createUnifiedToolExecutor(deps) 注入上下文（工作目录/路径安全/技能/时间引擎），
// 无头入口（bin/pi-agent.mjs）注入另一套上下文即可复用全部工具逻辑与安全防线。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { httpJsonFetch } from "../http.mjs";
import {
  matchDenyRule, isProtectedPath, DANGEROUS_CMD_RE, PI_CMDS, INTERACTIVE_CMD_RE, safeJoin,
} from "./security.mjs";
import { isSensitivePath, commandTouchesSensitive, redactSecrets } from "./secrets-guard.mjs";
import { withFileLock, FileLockTimeoutError } from "../file-lock.mjs";

/**
 * 写操作进锁；等锁超时（另一进程正持有）如实失败，而不是无锁硬写或抛异常带崩这一轮。
 * 跨进程锁的价值就在于"宁可这次不写，也不能覆盖别人"。
 */
async function lockedWrite(targetPath, argsPath, run) {
  try {
    return await withFileLock(targetPath, run);
  } catch (error) {
    if (error instanceof FileLockTimeoutError) {
      return { text: `⏳ 暂未写入 ${argsPath}：${error.message}。本次没有改动文件，稍后重试即可。`, isError: true };
    }
    throw error;
  }
}
import { formatSensitiveHint } from "../media-channels.mjs";
import { yuanshuExecutor } from "../yuanshu-loop.mjs";
import { execFileAbortable } from "../yuanshu-stability.mjs";
import { withUtf8CodePage, decodeWindowsOutput, looksMojibake, riskyForCmdShell } from "../windows-shell.mjs";
import { isCanonicalTarget, stageWrite } from "../memory-stages.mjs";

// ── 工具 schema（OpenAI function 格式）──
export const BASE_TOOL_SCHEMAS = [
  // 描述由 bashToolDescription() 动态给：实际用哪个 shell 就写哪个，别再让模型自己猜
  // （真机：描述写 cmd 而 pi 用 bash，同一个模型在两边各试一套命令，循环里白白多花 4~6 次调用）。
  { type: "function", function: { name: "bash", get description() { return bashToolDescription() + "出图/视频/配音用 generate_image / generate_video / generate_tts，不要读 auth.json/.token。不要 curl 本机 /api/image，不要启动 Vite 5173 或第二份 8787。" }, parameters: { type: "object", properties: { command: { type: "string", description: "要运行的命令" } }, required: ["command"] } } },
  { type: "function", function: { name: "read", description: "读取文件内容（工作空间内相对路径，或磁盘上的绝对路径如 D:/proj/file.json）", parameters: { type: "object", properties: { path: { type: "string", description: "文件路径" } }, required: ["path"] } } },
  { type: "function", function: { name: "write", description: "写入文件（自动创建目录）", parameters: { type: "object", properties: { path: { type: "string", description: "文件路径（相对工作空间）" }, content: { type: "string", description: "文件内容" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "edit", description: "用精确文本替换修改文件（先 read 再 edit）", parameters: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["path", "oldText", "newText"] } } },
  { type: "function", function: { name: "web_search", description: "联网搜索（Bing，无需 key）。未知事实、时效新闻才搜；独白/剧本/本会话已说过的事先按判断写。一次一两个查询，锁不到人就动手并汇报假设。", parameters: { type: "object", properties: { query: { type: "string", description: "搜索关键词（中文/英文均可）" } }, required: ["query"] } } },
];

// ── 纯工具函数 ──
export function stripHtml(s) { return String(s).replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim(); }
export function atobSafe(s) { return Buffer.from(String(s).trim(), "base64").toString("utf8"); }

// Windows 内联代码改写：node -e / python -c 的多行或引号嵌套代码在 cmd 下会被拆坏
// （典型错误：SyntaxError: unterminated string literal / "const ^^^^）
// 改写为写临时文件再执行。返回 {file, code, interp} 或 null（无需改写）
export function rewriteInlineCode(cmd) {
  const nodeM = cmd.match(/^\s*(?:node|nodejs|bun|deno)\s+(-e|--eval|--print)\s+(.+)$/s);
  const pyM = cmd.match(/^\s*(?:python|python3|py)\s+-c\s+(.+)$/s);
  if (!nodeM && !pyM) return null;
  const isNode = !!nodeM;
  const raw = (nodeM ? nodeM[2] : pyM[1]).trim();
  // 提取引号内的代码：支持双引号或单引号包裹
  let code = null;
  const dq = raw.match(/^"([\s\S]*?)"\s*$/);
  const sq = raw.match(/^'([\s\S]*?)'\s*$/);
  if (dq) code = dq[1];
  else if (sq) code = sq[1];
  else code = raw; // 无引号包裹（少见）
  // 是否需要改写：含换行 或 内部引号与包裹引号冲突
  const hasNewline = /\n/.test(code);
  const nestedQuote = dq ? /[\\"']/.test(code) : sq ? /["']/.test(code) : true;
  if (!hasNewline && !nestedQuote) return null; // 简单命令直接用
  const tmp = path.join(os.tmpdir(), `pi-inline-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${isNode ? "js" : "py"}`);
  return { file: tmp, code, interp: isNode ? (process.env.npm_node || process.execPath || "node") : "python" };
}

// cmd.exe 把 2>/dev/null 当成路径 /dev/null，报「系统找不到指定的路径」
export function rewriteCmdForWin32(cmd) {
  return String(cmd || "")
    .replace(/2>\s*\/dev\/null/gi, "2>nul")
    .replace(/(^|[^=\w])>\s*\/dev\/null/g, "$1>nul")
    .replace(/\/dev\/null/g, "nul");
}

// cmd.exe 在部分 Windows 代码页下处理中文绝对路径并不稳定。媒体任务常见的
// `mkdir ...` + `curl -o ...` 若只把错误重定向到 nul，会把“目录没建成”伪装成成功。
// 在交给 cmd 前用 Node 预建目录，既保留模型原命令，也让后续下载/ffmpeg 能落盘。
export function ensureCommandDirectories(cmd) {
  const text = String(cmd || "");
  const found = [];
  const collect = (re, directory) => {
    let match;
    while ((match = re.exec(text))) {
      const value = (match[1] || match[2] || match[3] || "").trim();
      if (!value || !/^(?:[a-zA-Z]:[\\/]|\\\\)/.test(value)) continue;
      found.push(directory ? value : path.dirname(value));
    }
  };
  collect(/\b(?:mkdir|md)\s+(?:"([^"]+)"|'([^']+)'|([^\s&|]+))/gi, true);
  collect(/(?:^|[\s&|])(?:-o|--output)\s+(?:"([^"]+)"|'([^']+)'|([^\s&|]+))/gi, false);
  for (const dir of found) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* cmd will return the original error */ }
  }
  return found;
}

// ── Web 搜索：Bing 网页搜索（免费无 key）。返回结构化结果列表 ──
export async function webSearchTool(query, httpFetch = httpJsonFetch) {
  try {
    const q = encodeURIComponent(String(query || "").slice(0, 200));
    const r = await httpFetch(`https://www.bing.com/search?q=${q}&count=5`, {
      method: "GET", timeout: 20000,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
    });
    if (!r || !r.ok) return `（搜索请求失败: HTTP ${r?.status || "?"}）`;
    const html = await r.text();
    const results = [];
    // Bing 结果块：<li class="b_algo">…<h2><a href="...">标题</a></h2>…<p class="b_lineclamp…">摘要</p>
    const re = /<li class="b_algo"[^>]*>([\s\S]*?)(?=<li class="b_algo"|<\/ol>|$)/g;
    let m;
    while ((m = re.exec(html))) {
      const block = m[1];
      const a = block.match(/<h2[^>]*>.*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
      if (!a) continue;
      const title = stripHtml(a[2]).slice(0, 120);
      let url = a[1].trim().replace(/&amp;/g, "&");
      // Bing 跳转链接：/ck/a 里的 u=a1…参数是 base64 编码的真实地址（如 aHR0cHM6…），解码还原
      const um = url.match(/[?&]u=a1([^&]+)/);
      if (um) {
        const enc = um[1].replace(/\+/g, " ");
        try {
          // 先试 base64（Bing 的 u 参数格式）
          const b64 = atobSafe(enc);
          if (/^https?:\/\//.test(b64)) url = b64;
          else url = decodeURIComponent(enc);
        } catch { try { url = decodeURIComponent(enc); } catch {} }
      }
      const snippet = p ? stripHtml(p[1]).slice(0, 200) : "";
      if (title) results.push({ title, url, snippet });
    }
    if (!results.length) return "（搜索无结果，可尝试换关键词）";
    return results.slice(0, 5).map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join("\n");
  } catch (e) {
    return `（搜索失败: ${String(e?.message || e).slice(0, 100)}）`;
  }
}

// ── 统一工具执行器工厂 ──
// deps:
//   cwd          () => string              bash 工作目录（如 CONFIG.cwd）
//   safePath     (p) => absPath|null       工作空间路径安全检查（wsSafePath）
//   activateSkill(name) => toolResult      activate_skill 技能加载（可选）
//   timeEngine   () => engine|null         time_task 时间引擎（可选）
//   httpFetch    (url, opts)               web_search 用的 HTTP 客户端（可选，默认 engine/http）
//   onLog        (msg) => void             日志回调（可选，默认 console.log）
// ── shell 探测（2026-09-16）──────────────────────────────────────────────
// 自研循环原本固定用 cmd.exe，而 pi 通道用的是 git-bash：同一个模型在两边的"能用什么命令"
// 完全不同 → 在循环里它只能猜 findstr/dir，浪费 4~6 次调用。这里优先找 git-bash 对齐 pi。
// 明确**不认** C:\Windows\System32\bash.exe（那是 WSL 启动器，MSYS 风格路径 /d/... 进去会失败）。
// 优先 usr\bin\bash.exe（真正的 bash 本体）：bin\bash.exe 只是个启动器，会再 re-exec 出
// usr\bin\bash.exe——多一层进程，abort/超时时就多一个杀不干净的孤儿（2026-09-16 实测：只杀启动器时
// 真 bash 攥着工作目录不放，临时目录删都删不掉）。
const GIT_ROOT_HINTS = [
  process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Git` : "C:\\Program Files\\Git",
  process.env["ProgramFiles(x86)"] ? `${process.env["ProgramFiles(x86)"]}\\Git` : "C:\\Program Files (x86)\\Git",
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs\\Git` : null,
].filter(Boolean);
const BASH_CANDIDATES = [
  process.env.YUANSHU_BASH, process.env.PI_BASH,
  ...GIT_ROOT_HINTS.map((root) => `${root}\\usr\\bin\\bash.exe`),
  ...GIT_ROOT_HINTS.map((root) => `${root}\\bin\\bash.exe`),
].filter(Boolean);
let _bashShell = undefined; // undefined=没探过 / string=用这个 / null=只能用 cmd

export function detectBashShell({ refresh = false } = {}) {
  if (!refresh && _bashShell !== undefined) return _bashShell;
  if (process.platform !== "win32") { _bashShell = process.env.SHELL || "/bin/bash"; return _bashShell; }
  for (const p of BASH_CANDIDATES) {
    try { if (p && fs.existsSync(p)) { _bashShell = p; return _bashShell } } catch {}
  }
  _bashShell = null;
  return _bashShell;
}

// 给模型看的描述必须和真实 shell 一致——描述说 cmd、实际给 bash（或反过来）都会让它乱试命令。
// 2026-09-18：把"编码 / 引号"这两条真机上反复咬人的规矩直接写进描述（写在工具里比写在记忆里可靠）。
const SHELL_HYGIENE = " 规矩：① 写中文内容一律用 write 工具，不要 `echo 中文 > f.txt`（cmd 会按 GBK 落盘，回头读就是乱码；本工具已替你切 chcp 65001，但别赌）；② 内联代码（node -e / python -c）会含引号与换行——本工具会自动改写成临时脚本，你也可以自己先写文件再跑；③ 路径带空格必须加引号（`\"C:\\Program Files\\...\"`），否则 cmd 会拆成两段。";
export function bashToolDescription() {
  const shell = detectBashShell();
  return shell
    ? "运行 bash（git-bash / MINGW64，Unix 语法）。用 grep -n / ls -1 | wc -l / find / sed 这类命令；工作空间路径写 /d/pi-workspace/... 或 D:/pi-workspace/... 都可以。不要用 cmd 的 findstr/dir/type(search 用 grep)。" + SHELL_HYGIENE
    : "运行 Windows cmd.exe（不是 bash/PowerShell）。优先使用工作空间相对路径，媒体下载先 mkdir 再 curl/ffmpeg；不要用 grep/ls（用 findstr/dir）。" + SHELL_HYGIENE;
}

export function createUnifiedToolExecutor(deps = {}) {
  const getCwd = deps.cwd || (() => process.cwd());
  const safePath = deps.safePath || ((p) => path.resolve(getCwd(), p || ""));
  // 2026-08-30 双根白名单：工作空间（CONFIG.cwd）+ 系统本体目录（server.mjs 所在 D:/pi-web）。
  // 自进化系统：模型需要能读写 pi-web 自身源码。注入 deps.systemDir 后 read/write/edit 双根可达；
  // 其余磁盘仍仅 read 只读。敏感凭据文件由 secrets-guard 在通道层拦截。
  const systemDir = deps.systemDir || "";
  const resolveToolPath = (p) => safePath(p) || (systemDir ? safeJoin(systemDir, p) : null);
  const activateSkill = deps.activateSkill || (() => ({ text: "技能系统未接入", isError: true }));
  const getTimeEngine = deps.timeEngine || (() => null);
  const httpFetch = deps.httpFetch || httpJsonFetch;
  const onLog = deps.onLog || ((msg) => console.log(msg));
  const sensitiveHint = deps.sensitiveHint || (() => formatSensitiveHint());

  return async function executeUnifiedTool(name, args, ctx = {}) {
    try {
      // 外部注册的自定义工具（2026-08-22）：dsh_task 等 pi 格式工具的统一兜底执行入口
      const extra = deps.extraExecutors?.[name] || yuanshuExecutor(name);
      if (extra) {
        const r = await extra(args, ctx);
        return typeof r === "object" && r !== null && "text" in r ? r : { text: String(r ?? "") };
      }
      if (name === "think") {
        // 外部思考草稿：只记录返回给前端展示，不执行、不落盘（调试用）
        const content = String(args?.content || "").trim();
        if (!content) return { text: "（空思考）", isError: true };
        return { text: "✅ 思考已记录（调试草稿，仅本次会话内存可见，不落盘）", think: content };
      }

      if (name === "time_task") {
        try {
          const timeEngine = getTimeEngine();
          if (!timeEngine) return { text: "时间引擎未初始化", isError: true };
          const a = String(args?.action || "");
          if (a === "register") {
            const r = timeEngine.register(args);
            if (r.error) return { text: `注册失败：${r.error}`, isError: true };
            return { text: `✅ 定时任务已注册（id=${r.id}）：${args.type} ${args.at}${args.day ? " 周" + args.day : ""}${args.date ? " " + args.date : ""} → ${String(args.prompt || "").slice(0, 60)}` };
          }
          if (a === "list") {
            const ts = timeEngine.list();
            if (!ts.length) return { text: "暂无定时任务" };
            return { text: "当前定时任务：\n" + ts.map(t => `  [${t.id}] ${t.type} ${t.at}${t.day ? " 周" + t.day : ""}${t.date ? " " + t.date : ""} | 已跑${t.runs}次 | ${String(t.prompt).slice(0, 40)}`).join("\n") };
          }
          if (a === "remove") {
            const r = timeEngine.remove(String(args?.id || ""));
            return r.removed ? { text: `✅ 已删除定时任务 ${args.id}` } : { text: `未找到任务 ${args.id}`, isError: true };
          }
          return { text: "未知 action（register/list/remove）", isError: true };
        } catch (e) { return { text: "time_task 异常: " + String(e?.message || e).slice(0, 100), isError: true }; }
      }
      if (name === "activate_skill") {
        // SDK 与统一引擎统一使用 name；兼容早期模型输出的 skill 字段，避免技能调用被静默吞掉。
        return activateSkill(args?.name || args?.skill);
      }
      if (name === "bash") {
        const cmd = String(args?.command || "").trim();
        if (!cmd) return { text: "空命令", isError: true };
        // ② 凭据防护：命令引用敏感文件 → 拒绝（混淆绕过由③输出脱敏兑底）
        if (commandTouchesSensitive(cmd)) return { text: sensitiveHint(), isError: false };
        // User 层 deny：宪法红线硬拦截（先于内置默认层检查）
        const deny = matchDenyRule(cmd);
        if (deny) {
          return { text: `⛔ 拒绝执行 [宪法规则 ${deny.id}]：该命令命中硬性红线（${deny.re.source.slice(0, 60)}…）。\n这是代码级拦截，不是建议——如需执行请联系伙伴人工操作。`, isError: true };
        }
        // 危险命令拦截（防 prompt injection / 幻觉触发不可逆操作）
        if (DANGEROUS_CMD_RE.test(cmd)) return { text: "⚠️ 拒绝执行：该命令可能造成不可逆数据丢失", isError: true };
        // 交互命令防护：pi / node / python 等命令若被模型幻觉出无效子命令，会进入交互模式挂起直到超时
        const piM = cmd.match(/^\s*pi(?:\s+([a-zA-Z-]+))?/);
        if (piM) {
          const sub = piM[1] || "";
          if (sub && !PI_CMDS.has(sub) && !sub.startsWith("--")) {
            return { text: `⚠️ "pi ${sub}" 不是有效命令（pi 支持: install/remove/update/list/config/auth）。\n正确用法：\n- 查看已安装包: pi list\n- 安装: pi install <source>\n- 卸载: pi remove <source>\n请改用正确的命令，或先运行 "pi --help" 查看完整用法。`, isError: true };
          }
        }
        // 其他常见的无输出交互命令直接拦截（避免挂起）：
        if (INTERACTIVE_CMD_RE.test(cmd)) return { text: `⚠️ 拒绝执行交互式命令（${cmd.slice(0, 40)}），可能挂起等待输入`, isError: true };
        // 2026-09-16：**优先用真正的 bash（git-bash / MINGW）**，与 pi 通道对齐。
        // 真机量测：同一个模型在 pi 通道一条 `grep -n` 就拿到答案（1 次调用），
        // 在自研循环里因为拿到的是 cmd.exe，只能猜 `findstr`/`dir /b`，试 5~7 次还有失败——
        // 「自研循环工具调用翻倍、更慢」的主因就是这个工具语义不一致。
        const shell = detectBashShell();
        const runCmd = shell ? cmd : (process.platform === "win32" ? rewriteCmdForWin32(cmd) : cmd);
        // 编码（2026-09-18）：cmd 默认代码页 936(GBK)，输出与 `>` 重定向都按 GBK 走。
        // 进 cmd 前先切 65001，让 `echo 中文 > f.txt` 这类写出来就是 UTF-8（否则回头 read 全是乱码）。
        // chcp 只在 cmd 这一支加：bash 本来就是 UTF-8，PowerShell 另有 -Encoding 一套规矩。
        const cmdWithCodepage = withUtf8CodePage(runCmd, { shell });
        // Windows cmd 引号问题修复：node -e / python -c 内联代码含换行或嵌套引号时，cmd 会拆坏代码（典型错误 "const ^^^^"）
        // 自动改写为「写临时文件再执行」，让模型的内联脚本稳定运行，消除工具重试循环的根源。
        // ⚠️ 2026-09-16：**bash 也要走这条改写**。不是为了引号（bash 引号没问题），而是为了 abort——
        // `bash -lc 'node -e …'` 被 abort 时杀掉的是 bash，node 变成孤儿继续跑（真机把 abort 用例拖到 30s 失败）。
        // 改写成 `execFile(node, [tmp])` 后，abort 杀的就是解释器本身，行为和以前一致。
        const fixed = rewriteInlineCode(shell ? cmd : cmdWithCodepage);
        if (fixed) {
          onLog(`[tools] 内联代码改写: ${cmd.slice(0, 60)}... -> ${fixed.file}`);
          try { fs.writeFileSync(fixed.file, fixed.code, "utf8"); } catch {}
        }
        const cleanup = fixed ? (() => { try { fs.unlinkSync(fixed.file); } catch {} }) : null;
        // 异步执行，避免阻塞事件循环（同步 execFileSync 会让整个服务器卡住）
        // 非零退出码也返回输出（如 grep 无匹配、git status 非干净状态），让模型自行判断；仅超时/被 kill 视为异常
        // 注意：改写后的内联代码必须绕过 cmd（cmd 会把带引号的绝对路径与 cwd 拼接，导致 MODULE_NOT_FOUND），直接 execFile 解释器
        const runOpts = { encoding: "buffer", timeout: 300000, cwd: getCwd(), windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal: ctx.signal };
        if (process.platform === "win32" && !shell) ensureCommandDirectories(cmdWithCodepage);
        const run = fixed
          ? execFileAbortable(fixed.interp, [fixed.file], runOpts)
          : shell
            ? execFileAbortable(shell, ["-lc", cmd], runOpts)
            : execFileAbortable(process.env.ComSpec || "cmd.exe", ["/c", cmdWithCodepage], runOpts);
        try {
          const { stdout, stderr, exitCode } = await run;
          cleanup?.();
          let text = decodeWindowsOutput(stdout);
          if (stderr && stderr.length) {
            const es = decodeWindowsOutput(stderr);
            text += (text ? "\n" : "") + es;
          }
          // 输出里还带乱码就顺手提示一句：这是**环境**问题，不该让模型一直重试
          if (looksMojibake(text)) text += "\n（输出里有乱码：可能是命令按 GBK 打印。写文件请用 write 工具，跑脚本请落成文件再执行。）";
          const exitMark = exitCode ? `\n[退出码 ${exitCode}]` : "";
          // 失败且这条命令本来就"过不了 cmd"时，直接说清是哪一类问题，省掉几轮瞎试
          let hint = "";
          if (exitCode && !shell) {
            const risk = riskyForCmdShell(cmd);
            if (risk) hint = `\n（这条命令过 cmd 有风险：${risk}）`;
          }
          return { text: (text.replace(/\r\n/g, "\n") || "(无输出)") + exitMark + hint, isError: exitCode ? true : false };
        } catch (e) {
          cleanup?.();
          if (e?.aborted || ctx.signal?.aborted) return { text: "客户端已断开，命令已中止", isError: true };
          const msg = String(e?.message || e);
          const reason = e?.killed || /timeout|killed/i.test(msg) ? "执行超过 5 分钟被终止" : "执行失败";
          return { text: `命令${reason}: ${msg.slice(0, 200)}`, isError: true };
        }
      }
      if (name === "read") {
        // ① 凭据防护：敏感文件对话通道一律不见
        if (isSensitivePath(String(args?.path || ""))) return { text: sensitiveHint(), isError: false };
        let p = resolveToolPath(args?.path);
        if (!p) {
          // 2026-08-30 read 放宽：双根外的磁盘绝对路径允许只读（与 bash 实际能力对齐）。
          // 相对路径 ../ 越界仍然拒绝（保留目录穿越防护）；写/编辑仅限双根白名单。
          const raw = String(args?.path || "");
          if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
            try {
              const real = fs.realpathSync(path.resolve(raw)); // 不存在会 throw → 保持拒绝
              if (fs.statSync(real).isFile() && !isSensitivePath(real)) p = real;
            } catch {}
          }
        }
        if (!p || !fs.existsSync(p)) return { text: `文件不存在或不可读: ${args?.path}（read 支持工作空间/系统目录内相对路径与磁盘绝对路径）`, isError: true };
        if (fs.statSync(p).isDirectory()) return { text: "这是一个目录，请指定文件", isError: true };
        // 二进制/图片文件不能按 utf8 硬读（2026-08-24 修复"read 一直失败"）
        const ext = path.extname(p).toLowerCase();
        const IMG = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".ico"];
        const BIN = [".pdf", ".wasm", ".zip", ".gz", ".mp3", ".mp4", ".wav", ".webm", ".exe", ".dll", ".apk", ".ttf", ".woff2"];
        const kb = Math.round(fs.statSync(p).size / 1024);
        if (IMG.includes(ext)) {
          return { text: `[图片文件] ${path.basename(p)} · ${kb}KB。文本通道无法读取像素内容；如需看图：①让用户直接在界面看；②换支持视觉的模型后以附件方式传入；③用 bash + python PIL 提取尺寸/主色等元信息`, isError: false };
        }
        if (BIN.includes(ext)) {
          return { text: `[二进制文件] ${path.basename(p)} · ${kb}KB（${ext}），不以文本读取。如需内容请用对应工具（如 pdftotext/ffmpeg/unzip）`, isError: false };
        }
        const c = fs.readFileSync(p, "utf8");
        return { text: c.slice(0, 50000), isError: false };
      }
      // 规范区（skills/** 与做梦的现役配置）不许直接写：先落草案区，等独立验证 PASS 或人批准。
      // 2026-09-18 真机事故：一个没验证过的技能直接进了 skills/（闸装在提案池上，没装在工具层，
      // 而 agent 手里就有 write）。纪律挡不住，只能在这里挡。
      const stageIfCanonical = (targetPath, content, why) => {
        if (process.env.YUANSHU_STAGE_GUARD === "0") return null;
        if (!isCanonicalTarget(targetPath, { wsRoot: getCwd() })) return null;
        const st = stageWrite(getCwd(), { target: targetPath, content, reason: why });
        if (!st?.ok) return null;
        return { text: `📥 这是规范区（${why}），已进草案区：${st.stagedPath}\n目标：${st.target}\n要通过独立验证（或人来批准）才会写进去；草案 id=${st.id}`, isError: false };
      };
      if (name === "write") {
        // ① 凭据防护 + 双根白名单（自进化：系统本体可写）
        if (isSensitivePath(String(args?.path || ""))) return { text: `⛔ 拒绝写入 [凭据防护]：${args?.path} 是敏感凭据文件`, isError: true };
        const p = resolveToolPath(args?.path);
        if (!p) return { text: "路径越权（write 仅限工作空间与系统目录内）", isError: true };
        if (isProtectedPath(p)) return { text: `⛔ 拒绝写入 [仓库法律]：${args?.path} 是受保护文件（人格/宪法/凭据），只读不写`, isError: true };
        const content = String(args?.content ?? "");
        // 规范区闸门（2026-09-18）：skills/** 与做梦的现役配置**不许直接写**——先落草案区，
        // 等独立验证 PASS 或人批准才真正落地。真机事故：一个没验证过的技能直接进了 skills/
        // （闸装在提案池上，没装在工具层，而 agent 手里就有 write）。纪律挡不住，在这里挡。
        const stagedWrite = stageIfCanonical(p, content, "技能/规则属于长期记忆");
        if (stagedWrite) return stagedWrite;
        // 与 Pi 的写工具共用同一把按文件队列，外层再套跨进程锁文件：
        // Pi 的 edit 是 async 的，不共用时"元枢 edit"与"Pi edit"打同一文件会交错；
        // 跨进程锁则挡住 dsh 子智能体 / headless 入口 / 外部脚本。
        return await lockedWrite(p, args?.path, async () => {
          fs.mkdirSync(path.dirname(p), { recursive: true });
          if (fs.existsSync(p)) {
            try {
              const current = fs.readFileSync(p, "utf8");
              if (current === content) return { text: `✅ ${args?.path} 已是目标内容（幂等恢复）`, isError: false, idempotent: true };
            } catch {}
          }
          fs.writeFileSync(p, content, "utf8");
          return { text: `✅ 已写入 ${args?.path}（${content.length} 字符）`, isError: false };
        });
      }
      if (name === "edit") {
        // ① 凭据防护 + 双根白名单
        if (isSensitivePath(String(args?.path || ""))) return { text: `⛔ 拒绝修改 [凭据防护]：${args?.path} 是敏感凭据文件`, isError: true };
        const p = resolveToolPath(args?.path);
        if (!p) return { text: `文件不存在或路径越权（edit 仅限工作空间与系统目录内）: ${args?.path}`, isError: true };
        if (isProtectedPath(p)) return { text: `⛔ 拒绝修改 [仓库法律]：${args?.path} 是受保护文件（人格/宪法/凭据），只读不写`, isError: true };
        const oldT = String(args?.oldText ?? "");
        const newT = String(args?.newText ?? "");
        // 读→替换→写是经典的 lost update 现场：与 Pi 的写工具共用同一把队列，
        // 外加速跨进程锁，并在锁内重读，避免用锁外的陈旧内容去替换。
        return await lockedWrite(p, args?.path, async () => {
          if (!fs.existsSync(p)) return { text: `文件不存在或路径越权（edit 仅限工作空间与系统目录内）: ${args?.path}`, isError: true };
          const c = fs.readFileSync(p, "utf8");
          if (!c.includes(oldT)) {
            if (c.includes(newT)) return { text: `✅ ${args?.path} 已是目标内容（幂等恢复）`, isError: false, idempotent: true };
            return { text: "未找到 oldText 片段（可能已修改）", isError: true };
          }
          const next = c.replace(oldT, newT);
          // 规范区闸门（2026-09-18，补 write 那一版的缺口）：edit 同样不许直接改 skills/** 与做梦现役配置。
          // 上一版只挡了 write，等于"锁了前门没锁后门"——所以这里把**改完之后的内容**送进草案区。
          {
            const stagedEdit = stageIfCanonical(p, next, "技能/规则属于长期记忆");
            if (stagedEdit) return stagedEdit;
          }
          // 锁只挡得住元枢自己的写工具，挡不住外部进程。写回前再核对一次，
          // 内容变了就如实拒绝——覆盖掉别人刚写的东西是静默数据丢失，比失败更糟。
          try {
            if (fs.readFileSync(p, "utf8") !== c) {
              return { text: `⛔ 拒绝写入：${args?.path} 在本次修改期间被外部改动过，请重新读取后再试（避免覆盖他人改动）`, isError: true };
            }
          } catch {}
          fs.writeFileSync(p, next, "utf8");
          return { text: `✅ 已修改 ${args?.path}`, isError: false };
        });
      }
      if (name === "web_search") {
        const r = await webSearchTool(args?.query, httpFetch);
        return { text: r, isError: r.startsWith("（搜索") || r.startsWith("(") ? true : false };
      }
      return { text: `未知工具: ${name}`, isError: true };
    } catch (e) {
      return { text: `工具执行失败: ${String(e?.message || e).slice(0, 200)}`, isError: true };
    }
  };
}

// 包装导出：③ 输出层兑底脱敏——所有工具输出过密钥值正则（防①②漏网，如 python 读凭据文件后打印）
export function createUnifiedToolExecutorGuarded(deps = {}) {
  const inner = createUnifiedToolExecutor(deps);
  return async function executeUnifiedTool(name, args, ctx) {
    const r = await inner(name, args, ctx);
    if (r && typeof r?.text === "string") {
      const redacted = redactSecrets(r.text);
      if (redacted !== r.text) r.text = redacted + "\n[secrets-guard: 输出含疑似凭据已脱敏]";
    }
    return r;
  };
}
