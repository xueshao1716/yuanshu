// ===== reflection-experience.mjs —— 反思要产出经验，不只是回放（2026-10-31）=====
//
// 真机：晚间汇报「今天 17 件事，沉淀 0 条」。两个问题：
//   ① 计数是坏的：entries 以 "### 2026-10-30 …" 开头，代码却用 startsWith(day) → 永远 0
//   ② 沉淀本来就靠她自觉写文件，反思链路根本不产出经验
//
// 这里补第二件：反思跑完后，如果今天一条经验都没有，就基于当天证据蒸馏 1–3 条写进经验库。
// 证据来自会话名、交付门判定、失败账本——**不许凭空编**，且写入前做格式与长度校验。
import fs from "node:fs";
import path from "node:path";

export const EXP_REL = path.join("工程", "经验库", "experience.md");
// 探针类会话不进经验证据：它们证明"系统能跑"，不产生"下次怎么做"
export const NOISE_SESSION = /(探针|验证|诊断|测试会话|交付门|回灌|身份\d*|培养身份|脚本验证|长任务推送|审计验证|probe|verify|diag|smoke|bench)/i;
export const COUNT_RE = /^#{2,4}\s*(\d{4}-\d{2}-\d{2})\b/;

/** 数某天的经验条目（修复 2026-10-30 之前 startsWith 永远 0 的 bug）。 */
export function countExperience(wsRoot, day) {
  try {
    const md = fs.readFileSync(path.join(String(wsRoot || "."), EXP_REL), "utf8");
    return md.split(/\r?\n/).filter((line) => {
      const m = line.match(COUNT_RE);
      return m ? m[1] === day : line.startsWith(day);
    }).length;
  } catch { return 0 }
}

/** 今天的证据：会话名、交付门判定、失败账本摘要。 */
export function gatherEvidence({ sessions = [], delivery = [], failures = [], day = "" } = {}) {
  const names = sessions.map((s) => String(s?.name || "").trim()).filter((n) => n && !NOISE_SESSION.test(n)).slice(0, 40);
  const verdicts = delivery.map((d) => `${d.verdict}${d.uncovered?.length ? `(${d.uncovered.length} 未覆盖)` : ""}`);
  const fails = failures.map((f) => String(f?.text || f?.reason || "").replace(/\s+/g, " ").slice(0, 80)).filter(Boolean).slice(0, 10);
  return { day, sessionNames: names, verdicts, failures: fails };
}

/** 组装给模型的提示：要求写成经验库格式，最多 3 条。 */
export function buildDistillPrompt({ day, sessionNames = [], verdicts = [], failures = [] } = {}) {
  return [
    "你是元枢里的小语。下面是今天的实际活动证据，请蒸馏成经验库条目。",
    "",
    `## 日期：${day}`,
    `## 今天动过的会话（${sessionNames.length} 个）：`,
    ...sessionNames.slice(0, 30).map((n) => `- ${n}`),
    verdicts.length ? `## 交付门判定：${verdicts.join("、")}` : "",
    failures.length ? `## 今天踩的坑：\n${failures.map((f) => `- ${f}`).join("\n")}` : "",
    "",
    "要求：",
    "1. 只写从证据里能看出来的东西；看不出来就不写，宁可只给 1 条。",
    "1.5 写的是教训，不是流水账：每条必须回答「下次遇到同类情况该怎么做」。只描述今天做了什么的，不要写。",
    "2. 最多 3 条，每条格式：",
    "   ### " + day + " <一句话标题>",
    "   - 🔑 下次：<可执行的做法——动词开头，说清先做什么、避免什么>",
    "   - ⚠️ <坑或注意>（没有就不写这行）",
    "3. 不许写没有证据支撑的数字、文件名、结论。",
    "4. 直接输出 Markdown，不要解释、不要前言后语。",
  ].filter(Boolean).join("\n");
}

/** 校验模型产出：必须有日期标题、条目数 1–3、每条不太长。 */
export function validateEntries(text, day) {
  const raw = String(text || "").trim();
  if (!raw) return { ok: false, error: "空内容" };
  const blocks = raw.split(/\n(?=#{2,4}\s)/).map((x) => x.trim()).filter(Boolean);
  const dated = blocks.filter((b) => new RegExp(`^#{2,4}\\s*${day}\\b`).test(b));
  if (!dated.length) return { ok: false, error: "没有带日期的标题" };
  if (dated.length > 3) return { ok: false, error: "超过 3 条" };
  const bad = dated.find((b) => b.length > 1200);
  if (bad) return { ok: false, error: "单条太长" };
  const noEvidence = dated.find((b) => !/[-*]\s/.test(b));
  if (noEvidence) return { ok: false, error: "条目没有要点行" };
  const noAction = dated.find((b) => !/(下次|以后|再次|先\s|必须|不要再|记得|优先)/.test(b));
  if (noAction) return { ok: false, error: "条目没写下次怎么做（流水账）" };
  return { ok: true, entries: dated };
}

/** 追加写入经验库（去重：标题已存在就跳过）。 */
export function appendEntries(wsRoot, entries, { now = new Date() } = {}) {
  const file = path.join(String(wsRoot || "."), EXP_REL);
  let old = "";
  try { old = fs.readFileSync(file, "utf8") } catch {}
  const titles = new Set(old.split(/\n/).filter((l) => /^#{2,4}\s/.test(l)).map((l) => l.replace(/^#+\s*/, "").trim().toLowerCase()));
  const fresh = entries.filter((e) => {
    const title = e.split(/\n/)[0].replace(/^#+\s*/, "").trim().toLowerCase();
    return title && !titles.has(title);
  });
  if (!fresh.length) return { ok: true, written: 0, skipped: entries.length };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const add = "\n" + fresh.join("\n\n") + "\n";
    fs.appendFileSync(file, add, "utf8");
    return { ok: true, written: fresh.length, skipped: entries.length - fresh.length, file };
  } catch (e) {
    return { ok: false, written: 0, error: String(e?.message || e).slice(0, 160) };
  }
}

/**
 * 反思产出经验：今天没有经验时蒸馏一次并写入。
 * @param {{wsRoot:string, day:string, evidence:object, write:(prompt:string)=>Promise<string>, force?:boolean}} opts
 */
export async function distillExperience({ wsRoot, day, evidence, write, force = false } = {}) {
  const before = countExperience(wsRoot, day);
  if (before > 0 && !force) return { ok: true, written: 0, count: before, reason: "今天已有经验" };
  if (!evidence?.sessionNames?.length && !evidence?.failures?.length) return { ok: true, written: 0, count: before, reason: "今天没有可蒸馏的证据" };
  if (typeof write !== "function") return { ok: false, written: 0, count: before, error: "没有写作通道" };
  let text = "";
  try { text = String((await write(buildDistillPrompt({ day, ...evidence }))) || "") } catch (e) {
    return { ok: false, written: 0, count: before, error: String(e?.message || e).slice(0, 160) };
  }
  const v = validateEntries(text, day);
  if (!v.ok) return { ok: false, written: 0, count: before, error: `产物不合格：${v.error}` };
  const out = appendEntries(wsRoot, v.entries);
  const count = countExperience(wsRoot, day);
  return { ok: out.ok, written: out.written || 0, skipped: out.skipped || 0, count, titles: v.entries.map((e) => e.split(/\n/)[0].replace(/^#+\s*/, "").trim()).slice(0, 3), error: out.error };
}
