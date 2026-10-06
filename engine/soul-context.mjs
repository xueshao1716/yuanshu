// 灵魂快照：把「灵魂培养」里属于小语自己的长期约定（纠正、对伙伴的了解）每轮交给模型。
// 以前这些只写在记忆文件里，靠 APPEND_SYSTEM.md 里一句「会话开始先 read 记忆文件」——
// 模型不照做就等于没有，前台小语实际只被记忆日志的时间点和经验索引驱动。
// 只读，按文件 mtime 缓存；两条引擎（pi nextTurn / 元枢 system 区段）共用这一份文本。
import fs from "node:fs";
import path from "node:path";

const MAX_FIXES = 14;
const MAX_RELATION = 6;
const clip = (s, n = 120) => { const t = String(s || "").replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
// 「记得 / 以后 / 永远」才说明是长期约定；「不要再调用任何工具」这类一轮内的要求会被自动记成纠正，不能每轮都注入
const DURABLE = /记得|记住|以后|今后|永远|长期|每次|所有/;

// 解析纠正记忆：按「### 时间」分块，取 纠正/同场纠正/追加纠正 与「规矩」类加粗条目；新的在前、去重
export function parseCorrections(text) {
  const blocks = String(text || "").split(/^#{2,3}\s+/m);
  const out = [];
  for (const block of blocks) {
    const trigger = (block.match(/^- 触发:\s*(.+)$/m) || [])[1] || "";
    for (const m of block.matchAll(/^\s*(?:\d+\.\s+|- )(?:(?:同场|追加)?纠正:\s*)?(.+)$/gm)) {
      const line = m[0].trim();
      const body = m[1].trim();
      if (/^- (触发|\d{4}-\d{2}-\d{2} \[)/.test(line)) continue;
      const tagged = /纠正:/.test(line);
      const bold = /\*\*/.test(body);
      if (!tagged && !bold) continue;
      const plain = clip(body, 100);
      if (/[：:]$/.test(plain)) continue; // 「规矩（此后不再犯）：」这类小标题
      if (!bold && plain.length < 14 && !DURABLE.test(trigger)) continue;
      out.push(plain);
    }
  }
  return [...new Set(out.reverse())].slice(0, MAX_FIXES);
}

export function parseRelation(text) {
  return [...String(text || "").matchAll(/^- (.+)$/gm)].map((m) => clip(m[1], 100)).filter(Boolean).reverse().slice(0, MAX_RELATION);
}

export function renderSoulContext({ fixes = [], relation = [] } = {}) {
  const parts = [];
  if (fixes.length) parts.push(`伙伴纠正过、不能再犯的（新的在前）：\n${fixes.map((f) => `- ${f}`).join("\n")}`);
  if (relation.length) parts.push(`我对伙伴的了解：\n${relation.map((f) => `- ${f}`).join("\n")}`);
  if (!parts.length) return "";
  return `【灵魂快照·常驻】来自灵魂培养中心（记忆/纠正记忆.md、记忆/关系记忆.md），这是我自己的长期约定，按它做事，不要在回复里复述。\n${parts.join("\n")}`;
}

let cache = { key: "", text: "" };
export function soulContextPrompt(wsRoot) {
  if (!wsRoot) return "";
  const files = ["记忆/纠正记忆.md", "记忆/关系记忆.md"].map((rel) => path.join(wsRoot, rel));
  const stamp = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
  const key = files.map((f) => `${f}:${stamp(f)}`).join("|");
  if (key === cache.key) return cache.text;
  const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
  const text = renderSoulContext({ fixes: parseCorrections(read(files[0])), relation: parseRelation(read(files[1])) });
  cache = { key, text };
  return text;
}
