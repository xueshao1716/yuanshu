// ===== plan-refine.mjs —— 计划细化：把"一句模糊的话"补成"能动手的计划"（2026-10-26）=====
//
// dryRun 的教训：自动补丁拒绝执行，理由正确——提案只说"作业失败 5 次"，
// 没有失败样本、没有调用点、没有最小复现。生成器只能猜，而猜就会改坏。
//
// 所以在补丁之前先补三样，全部来自**可验证的事实**（不是让模型编）：
//   ① 失败样本：作业台账 / 后台日志里的真实报错（带时间与来源）
//   ② 调用点：在允许改动的文件里搜到的确切 file:line（带 3 行上下文）
//   ③ 最小复现：按领域给一个"能跑起来、能红"的复现配方
//
// 产出写进 PLAN.md 的「细化」章节，并存回提案（plan.refinement），供生成器使用。
import fs from "node:fs";
import path from "node:path";

export const MAX_SAMPLES = 5;
export const MAX_SITES = 10;

/** 从提案里取检索词：标题/症状/钩子里的词 + 引号里的字面量。 */
export function searchTerms(proposal = {}) {
  const text = `${proposal.title || ""} ${proposal.symptom || ""} ${proposal.focusHook || ""} ${proposal.plan?.focusHook || ""}`;
  const terms = new Set();
  for (const m of text.matchAll(/「([^」]{2,20})」/g)) {
    terms.add(m[1].trim());                                      // 完整名字
    const longest = m[1].split(/[\s\-_/]+/).sort((a, b) => b.length - a.length)[0];
    if (longest && longest.length >= 2) terms.add(longest);        // 最长的一段（匹配日志文件名用）
  }
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_.-]{4,}/g)) terms.add(m[0]);
  for (const m of text.matchAll(/[A-Za-z]:[\\/][^\s"']+|[\w.-]+\.(?:mjs|cjs|js|ts)\b/g)) terms.add(m[0]);
  return [...terms].slice(0, 10);
}

/** ① 失败样本：作业台账 + 后台作业日志。 */
export function gatherFailureSamples(wsRoot, proposal = {}, { limit = MAX_SAMPLES } = {}) {
  const root = String(wsRoot || ".");
  const terms = searchTerms(proposal).map((t) => t.toLowerCase());
  const hit = (s) => !terms.length || terms.some((t) => String(s).toLowerCase().includes(t));
  const out = [];

  // 作业台账
  try {
    const led = JSON.parse(fs.readFileSync(path.join(root, "记忆", "运行时", "待汇报.json"), "utf8"));
    const rows = Array.isArray(led) ? led : Array.isArray(led.items) ? led.items : [];
    for (const r of rows) {
      if (!["failed", "stalled"].includes(String(r.state || ""))) continue;
      if (!hit(`${r.label || ""} ${r.step || ""}`)) continue;
      out.push({
        source: "job-ledger",
        at: r.at || r.finishedAt || null,
        text: `${r.label || r.id || "?"} · ${r.state} · ${String(r.step || r.error || "").slice(0, 240)}`,
      });
      if (out.length >= limit) break;
    }
  } catch {}

  // 后台作业日志尾部（失败作业才有意义）
  if (out.length < limit) {
    try {
      const dir = path.join(root, "bg-jobs");
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".log"))) {
        if (!hit(f)) continue;
        const text = fs.readFileSync(path.join(dir, f), "utf8");
        const lines = text.split(/\r?\n/).filter((l) => /error|Error|失败|fail|exit code|ENOENT|EACCES/.test(l));
        if (!lines.length) continue;
        out.push({ source: `bg-jobs/${f}`, at: null, text: lines.slice(-3).join(" ⏎ ").slice(0, 400) });
        if (out.length >= limit) break;
      }
    } catch {}
  }
  return out;
}

/** ② 调用点：在允许改动的文件里找检索词，返回 file:line + 3 行上下文。 */
export function findCallSites(repoRoot, plan = {}, { limit = MAX_SITES } = {}) {
  const root = String(repoRoot || ".");
  const files = (plan.files || []).filter((f) => !String(f).endsWith("/"));
  // 中文词也要搜（代码里有中文错误文案/注释）；标识符放宽到 ≥3 字符（如 job_status、ffmpeg）
  const terms = searchTerms(plan).filter((t) => t.length >= 3);
  const sites = [];
  for (const rel of files) {
    let text;
    try { text = fs.readFileSync(path.join(root, rel), "utf8"); } catch { continue }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && sites.length < limit; i += 1) {
      const line = lines[i];
      const term = terms.find((t) => line.includes(t));
      if (!term) continue;
      sites.push({
        path: rel, line: i + 1, term,
        excerpt: lines.slice(Math.max(0, i - 1), i + 2).map((l, k) => `${Math.max(1, i) + k}: ${l.trim().slice(0, 160)}`).join("\n"),
      });
    }
  }
  return sites;
}

/**
 * 全仓库搜（只读建议，不作为可改动目标）。
 * 动机：真机上细化发现"允许改动的文件里一处都搜不到"，而失败其实发生在 bat 脚本/路径编码上——
 * 也就是**计划指错了文件**。把可能的位置列出来，人一眼就能判断要不要改计划。
 */
export function suggestSites(repoRoot, plan = {}, { limit = 6 } = {}) {
  const root = String(repoRoot || ".");
  const terms = searchTerms(plan).filter((t) => t.length >= 3 && !/^[\d.]+$/.test(t));
  if (!terms.length) return [];
  const SKIP = new Set(["node_modules", ".git", "记忆", "dist", "release", "build", ".next", "coverage"]);
  const out = [];
  const walk = (dir, depth) => {
    if (out.length >= limit || depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue }
      if (!/\.(mjs|cjs|js|ts|tsx|bat|cmd|ps1|json)$/.test(e.name)) continue;
      let text;
      try { text = fs.readFileSync(full, "utf8") } catch { continue }
      if (text.length > 400_000) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && out.length < limit; i += 1) {
        const term = terms.find((t) => lines[i].includes(t));
        if (!term) continue;
        out.push({ path: path.relative(root, full).replace(/\\/g, "/"), line: i + 1, term, text: lines[i].trim().slice(0, 140) });
      }
    }
  };
  walk(root, 0);
  return out;
}

/** ③ 最小复现：按领域给一个能跑起来、能红的配方（模板化，不求模型）。 */
export function minimalRepro(proposal = {}, { samples = [], sites = [] } = {}) {
  const area = proposal.area || proposal.plan?.area || "general";
  const hint = samples[0]?.text?.slice(0, 80) || proposal.symptom || "";
  const recipe = {
    render: [
      "1) 用 run_detached 起一个**必失败**的渲染命令（例如 ffmpeg 指向不存在的输入），拿到 jobId；",
      "2) 调 job_status 断言：该作业 state=failed、有 error 文案、且**不会**被无限重排；",
      "3) 再起一个成功命令，断言不会因为上面的失败而被误标。",
    ],
    knowledge: [
      "1) 造一条带已知 claim 的样本，走 commit；",
      "2) 断言 entries() 校验通过、claimType/expiresAt 正确；",
      "3) 断言 journal.hash === digest(entry)（凭据一致性）。",
    ],
    feedback: [
      "1) 造一条缺构建号的报告；",
      "2) 断言研判为 no_build，回信包含「要补什么」；",
      "3) 断言回信不会承诺「已经在修」。",
    ],
    shell: [
      "1) 写一个含中文的脚本，跑一遍；",
      "2) 断言输出按 UTF-8 解码无乱码；",
      "3) 断言失败时退出码非 0（不许静默成功）。",
    ],
    deploy: [
      "1) 连续两次 release-restart；",
      "2) 断言端口释放、health 200、只有一个实例；",
      "3) 断言盖章版本 === version.json。",
    ],
    general: [
      "1) 用最小输入复现症状，先让它红；",
      "2) 修完断言同一输入不再复现；",
      "3) 补一条相邻行为的回归断言。",
    ],
  }[area] || ["1) 最小输入复现；2) 修复后不复现；3) 相邻行为回归。"];
  return {
    area,
    hint: hint.slice(0, 120),
    steps: recipe,
    callSites: sites.slice(0, 3).map((s) => `${s.path}:${s.line}（${s.term}）`),
  };
}

/** 细化：把三样东西并进 plan，返回给调用方（不写盘）。 */
export function buildRefinement({ wsRoot, repoRoot, proposal = {} }) {
  const plan = { ...proposal.plan, ...proposal };
  const samples = gatherFailureSamples(wsRoot, plan);
  const sites = findCallSites(repoRoot, plan);
  const repro = minimalRepro(plan, { samples, sites });
  // 允许列表里一处都没命中 → 去全仓库找证据，指出"计划可能指错了文件"
  const suggestions = sites.length ? [] : suggestSites(repoRoot, plan);
  return { samples, sites, suggestions, repro, refinedAt: Date.now(), complete: samples.length > 0 && sites.length > 0 };
}

/** 渲染成 PLAN.md 的追加章节（幂等：替换已有「## 细化」块）。 */
export function renderRefinement(ref = {}) {
  const lines = [
    "## 细化（自动补充，事实来源）",
    "",
    `- 完成度：${ref.complete ? "样本与调用点都有，可以尝试自动补丁" : "仍不完整——缺" + (ref.samples?.length ? "" : "失败样本") + (ref.sites?.length ? "" : (ref.samples?.length ? "调用点" : "、调用点"))}`,
    "",
    "### 失败样本",
    "",
    ...(ref.samples?.length
      ? ref.samples.map((s) => `- ${s.source}${s.at ? ` · ${new Date(s.at).toISOString().slice(0, 16)}` : ""}：${s.text}`)
      : ["- （没有找到匹配的失败记录——先补样本，再谈改代码）"]),
    "",
    "### 调用点",
    "",
    ...(ref.sites?.length
      ? ref.sites.map((s) => `- \`${s.path}:${s.line}\`（命中 ${s.term}）\n\n\`\`\`\n${s.excerpt}\n\`\`\``)
      : ["- （允许改动的文件里没搜到相关调用点——计划列的文件可能不对）"]),
    "",
    ...(ref.suggestions?.length
      ? ["### 计划可能指错了文件（全仓库命中，但不在允许范围）", "", ...ref.suggestions.map((x) => `- \`${x.path}:${x.line}\`（命中 ${x.term}）：${x.text}`), ""]
      : []),
    "### 最小复现",
    "",
    ...(ref.repro?.steps || []).map((s) => `- ${s}`),
    ref.repro?.hint ? `\n> 症状摘要：${ref.repro.hint}` : "",
    "",
  ].filter((x) => x !== "");
  return lines.join("\n");
}

/** 把细化写进 PLAN.md（就地替换旧块）并返回新内容。 */
export function applyRefinementToPlanFile(planPath, ref) {
  const block = renderRefinement(ref);
  let text = "";
  try { text = fs.readFileSync(planPath, "utf8"); } catch { throw new Error("PLAN.md 不存在") }
  const at = text.indexOf("## 细化（自动补充");
  const head = at >= 0 ? text.slice(0, at).replace(/\s+$/, "") + "\n\n" : text.replace(/\s+$/, "") + "\n\n";
  fs.writeFileSync(planPath, head + block + "\n", "utf8");
  return { planPath, complete: !!ref.complete };
}
