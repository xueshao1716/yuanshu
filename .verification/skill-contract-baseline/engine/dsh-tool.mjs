// ===== dsh-tool.mjs —— dsh（DeepSeek Harness）执行臂工具（从 server.mjs 抽离）=====
// 模式：pi 主引擎（规划/对话/记忆/验收）→ 派单 dsh 执行（代码/沙箱/工作流）→ 结果回 pi 验收交付。
// 通过工厂注入宿主上下文：cwd / piPackage（typebox 解析基准）/ loadSkillIndex / skillsDir。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { execFileAbortable } from "./yuanshu-stability.mjs";

// dsh 认证环境：DEEPSEEK_API_KEY 只从当前进程环境或本机 auth.json 解析。
// 凭证留在本机，元枢不会替用户登录外部平台，也不会把密钥写进仓库。
export function resolveDshEnv() {
  const env = { ...process.env };
  // Windows 的 process.env 大小写不敏感，但展开成普通对象后会变成大小写敏感。
  // 统一回 PATH，避免调用方读取 env.PATH 时丢失原环境。
  if (process.platform === "win32") {
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
    if (pathKey && pathKey !== "PATH") {
      env.PATH = env[pathKey];
      delete env[pathKey];
    }
  }
  if (env.DEEPSEEK_API_KEY) return env;
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "auth.json"), "utf8"));
    if (auth?.deepseek?.key) env.DEEPSEEK_API_KEY = auth.deepseek.key;
  } catch {}
  return env;
}

// 结构化回传协议：从 dsh headless 输出中容错提取 JSON 块（结果+步骤+工具+元数据）
// headless 是黑盒（事件不落盘、stderr 空），只能让模型按协议自报过程，解析失败则回退纯文本
export function extractStructuredOut(text) {
  if (!text) return { ok: false, raw: text || "" };
  const isValid = (d) => d && typeof d === "object" && "result" in d; // 协议强制：必须含 result
  // 1) 优先取 ```json 代码块
  const jb = String(text).match(/```json\s*([\s\S]*?)```/);
  if (jb) {
    try { const d = JSON.parse(jb[1]); if (isValid(d)) return { ok: true, data: d, raw: text }; } catch {}
  }
  // 2) 从后往前扫所有 {，取第一个含 result 的完整 JSON 块（避免命中嵌套的 meta 对象）
  const s = String(text);
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] !== "{") continue;
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === "{") depth++;
      else if (s[j] === "}") {
        depth--;
        if (depth === 0) {
          try {
            const d = JSON.parse(s.slice(i, j + 1));
            if (isValid(d)) return { ok: true, data: d, raw: text };
          } catch {}
          break;
        }
      }
    }
  }
  return { ok: false, raw: text };
}

// dsh 引擎入口：Windows 无 dsh.exe（只有 dsh.cmd shim）——直接 spawn node 执行真实 bin.js，
// 避免 shell 注入风险（task 是模型生成的，经 shell 拼接有命令注入面）
let _dshBin = null;
export function resolveDshBin() {
  if (_dshBin) return _dshBin;
  try {
    const cands = [
      path.join(process.env.APPDATA || "", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
      path.join(process.env.ProgramFiles || "", "nodejs", "node_modules", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    ];
    for (const c of cands) {
      if (fs.existsSync(c)) { _dshBin = c; return c; }
    }
  } catch {}
  return "dsh"; // 回退：让系统 PATH 尝试（类 Unix 环境 dsh 在 PATH 中）
}

// dsh 失败原因翻译：stderr 里才有真相（QUOTA/401…），err.message 只有命令行——
// 不翻译的话用户只能看到 "Command failed: node.exe ..."，永远不知道为什么。
export function friendlyDshError(rawErr, rawStderr) {
  const raw = String(rawStderr || rawErr || "");
  if (/heap limit|Last few GCs|FATAL ERROR|OOM|JavaScript heap/i.test(raw)) return "dsh 进程内存溢出（OOM）：多为冷启动期偶发，稍等重试即可；反复出现时调低 PI_DSH_MAX 并发上限";
  if (/QUOTA|Insufficient Balance|402/i.test(raw)) return "dsh 引擎（DeepSeek）余额不足：请到 platform.deepseek.com 充值，或改用 pi 自带工具/其他模型通道完成本任务";
  if (/401|Unauthorized|invalid.{0,12}key|API.?Key/i.test(raw)) return "dsh 引擎认证失败：DEEPSEEK_API_KEY 无效或未配置（可在元枢模型管理勾选「同步到 dsh」重配）";
  if (/not found|ENOENT|Cannot find module/i.test(raw)) return "dsh 引擎未安装或路径失效：请运行 npm i -g @deepseek-ai/dsh 后重试";
  if (/timeout|TIMEDOUT/i.test(raw)) return "dsh 执行超时（180s）：任务可能过大，建议拆分子任务";
  return String(rawStderr || rawErr || "").slice(0, 200) || "未知错误";
}

export function createDshTool({ cwd, piPackage, loadSkillIndex, skillsDir, onLog = (m) => console.log(m) }) {
  let toolDef = null;
  // dsh 并发控制：默认最多 6 个同时跑（用户定），硬上限 15，防后台进程堆积憋死电脑
  // 可通过环境变量 PI_DSH_MAX 调整；总进程数 = dsh 并发 + 系统 node 基础进程
  let active = 0;
  const max = Math.min(parseInt(process.env.PI_DSH_MAX || "6", 10), 15);

  // dsh 技能上下文：渐进式披露技能库，让 dsh 学会按技能执行
  // dsh headless 自带 read 工具，可直接读 skills/<name>/SKILL.md 全文
  function skillContext() {
    try {
      const list = loadSkillIndex();
      if (!list?.length) return "";
      const dir = String(skillsDir).replace(/\\/g, "/");
      return `\n\n【元枢技能库（${list.length} 个）】对得上就 read 技能全文再做，对不上按你的判断做。\n${list.map((s) => `- ${s.name}：${String(s.desc).slice(0, 120)}`).join("\n")}\n技能文件位置：${dir}/<技能名>/SKILL.md`;
    } catch { return ""; }
  }

  async function initDshTool() {
    if (toolDef) return toolDef;
    // Pi SDK 缺失时元枢仍可独立启动；不要把空路径交给 createRequire，
    // 否则 Node 会把它当成当前目录并打印误导性的 filename 错误。
    if (!piPackage) {
      onLog("[dsh] Pi SDK 不可用，跳过 dsh 工具初始化");
      return null;
    }
    try {
      const { createRequire } = await import("node:module");
      const req2 = createRequire(piPackage);
      const { Type } = req2("typebox");
      toolDef = {
        name: "dsh_task",
        label: "dsh 引擎执行（代码/沙箱/工作流）",
        description: "把子任务派单给 DeepSeek Harness（dsh）引擎独立执行。dsh 擅长：安全执行模型编写的代码（Code Mode）、沙箱内跑程序、复杂多步数据处理/工作流编排。当你（pi）需要执行一段生成的代码/脚本、在沙箱环境跑程序、或做多步数据处理时，把任务完整描述给它，拿到结果后由你验收并交付。日常文件读写/搜索/简单命令用自带工具，不要滥用。",
        promptSnippet: "需要安全执行代码/沙箱/多步工作流时，用 dsh_task 派单给 dsh 引擎，拿到结果后验收交付",
        promptGuidelines: [
          "Use dsh_task when a subtask needs: executing model-written code safely (Code Mode), sandboxed program runs, or multi-step data processing.",
          "Write a complete, self-contained task description — dsh runs as an independent session without conversation history.",
          "After dsh returns, YOU verify the result (re-read/check outputs) before presenting it to the user.",
          "Do NOT use it for simple file ops or one-line commands. Do NOT chain multiple dsh_task calls in one turn.",
        ],
        parameters: Type.Object({
          task: Type.String({ description: "派单给 dsh 的完整任务描述（自包含：目标/输入/期望输出/约束）" }),
        }),
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          const task = String(params?.task || "").trim();
          if (!task) return { content: [{ type: "text", text: "缺少任务描述" }] };
          if (signal?.aborted) return { content: [{ type: "text", text: "客户端已断开，dsh 任务已中止" }], isError: true };
          // 并发控制：达到上限（默认 6）拒绝新任务，让 pi 稍后重试
          if (active >= max) return { content: [{ type: "text", text: `⚠️ dsh 引擎已达并发上限（${active}/${max}）。请稍后重试，或改用自带工具完成。` }] };
          // 清理残留：先回收异常退出/超时遗留的 dsh headless 进程（防内存堆积）
          // ⚠️ 2026-08-20 修复自毁竞态：原为 fire-and-forget，CIM 枚举 1-3s 后才执行 Stop-Process，
          // 此时刚 spawn 的 dsh 已注册且命中 'dsh.*headless' 模式 → 被自己人杀掉（stderr 截断、报错失真）。
          // 必须 await 清理完成后再 spawn。
          try {
            await new Promise((r) => {
              execFile("powershell", ["-NoProfile", "-Command",
                "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'dsh.*headless' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
              ], { timeout: 8000, windowsHide: true }, () => r());
            });
          } catch {}
          active++;
          if (onUpdate) onUpdate({ type: "status", content: [{ type: "text", text: `⏳ 已派单 dsh 引擎执行（冷启动约 5-20s，当前并发 ${active}/${max}）…` }] });
          try {
            // 结构化协议：要求 dsh 末尾输出 JSON（结果+步骤+工具+元数据），pi 容错解析后基于轨迹验收
            const structReq = "\n\n【输出格式要求（必须严格遵守）】\n执行完成后，在回复末尾单独输出一个 JSON 块（直接以 { 开头，不要放在代码块里，JSON 前后不要有其他文字）：\n{\"result\":\"给用户的最终结论(简洁)\",\"steps\":[\"关键步骤1\",\"关键步骤2\"],\"tools\":[\"工具名: 说明\"],\"meta\":{\"duration\":\"估算耗时\",\"files\":[\"涉及的文件路径\"]}}\nJSON 必须合法，步骤和工具如实填写。";
            let out;
            try {
              const spawned = await execFileAbortable(process.execPath, [resolveDshBin(), "--profile", "headless", task + skillContext() + structReq], {
                cwd, encoding: "utf8", timeout: 180000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
                env: resolveDshEnv(),
                signal,
              });
              out = { ok: true, out: String(spawned.stdout || "").trim(), err: "", stderr: String(spawned.stderr || "").trim().slice(0, 300) };
            } catch (e) {
              if (e?.aborted || signal?.aborted) return { content: [{ type: "text", text: "客户端已断开，dsh 任务已中止" }], isError: true };
              out = { ok: false, out: "", err: String(e?.message || e).slice(0, 200), stderr: "" };
            }
            const text = (out.out || "").trim();
            const parsed = extractStructuredOut(text);
            if (parsed.ok && parsed.data) {
              const d = parsed.data;
              const parts = [];
              parts.push(`【dsh 执行结果】${String(d.result || text).slice(0, 1000)}`);
              if (Array.isArray(d.steps) && d.steps.length) parts.push(`【执行步骤】\n${d.steps.map((s, i) => `${i + 1}. ${String(s).slice(0, 200)}`).join("\n").slice(0, 1500)}`);
              if (Array.isArray(d.tools) && d.tools.length) parts.push(`【工具调用】${d.tools.map(String).join("；").slice(0, 800)}`);
              if (d.meta && typeof d.meta === "object") {
                const m = [];
                if (d.meta.duration) m.push(`耗时 ${d.meta.duration}`);
                if (Array.isArray(d.meta.files) && d.meta.files.length) m.push(`文件 ${d.meta.files.join(", ").slice(0, 300)}`);
                if (m.length) parts.push(`【元数据】${m.join("；")}`);
              }
              parts.push(`【原始输出】${(text || "（dsh 无输出）").slice(0, 2000)}`);
              return { content: [{ type: "text", text: out.ok ? parts.join("\n\n") : `【dsh 执行失败】${friendlyDshError(out.err, out.stderr)}\n\n${parts.join("\n\n")}` }] };
            }
            // 未按协议输出：回退纯文本（不编造轨迹）
            const t2 = (text || "（dsh 无输出）").slice(0, 4000);
            return { content: [{ type: "text", text: out.ok ? `【dsh 执行结果】\n${t2}` : `【dsh 执行失败】${friendlyDshError(out.err, out.stderr)}\n${t2}` }] };
          } catch (e) {
            return { content: [{ type: "text", text: `dsh 调用异常: ${String(e?.message || e).slice(0, 200)}` }] };
          } finally {
            active--; // 无论成败都释放并发额度
          }
        },
      };
    } catch (e) {
      onLog(`[dsh] 工具初始化失败: ${String(e?.message || e).slice(0, 100)}`);
    }
    return toolDef;
  }

  return { initDshTool };
}

export default createDshTool;
