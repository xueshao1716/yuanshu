// ===== wechat-rules.mjs —— 微信"规矩"从代码里搬到可编辑文件（2026-10-28）=====
//
// 用户的观察：**「得每轮给他注入一定独立的词，不然不会干了」**——这话是对的，也是脆弱的：
// 规矩写死在代码里，改一句要改代码、要重启；写在人设里会被上下文压缩掉。
//
// 折中：规矩放成**工作区里的一个文件**，每轮读它（按 mtime 缓存），
//   · 想改就改文件，不用改代码；
//   · 文件缺失/读不出来就回落到内置默认（不会因为文件丢了就变哑巴）。
import fs from "node:fs";
import path from "node:path";

export const RULES_REL = path.join("记忆", "运行时", "微信规矩.md");

export const DEFAULT_RULES = [
  "【微信环境】你在跟伙伴的微信私聊里（手机看）。规矩：",
  "1) 短、口语，别长篇分点；Markdown 少量可用。",
  "2) 发图：本地先生成/找到文件，然后单独一行写 ![图](绝对路径)。发文件同理单独一行写绝对路径。",
  "3) 能做就直接做，别只说“我去看看/稍等”；做不到就直说。",
  "4) 能联网：web_search 或 bash curl，先查再说查不到。",
].join("\n");

const cache = new Map(); // file -> { mtimeMs, text }

/**
 * 读规矩：文件优先，缺失或为空则用内置默认。
 * @param {string} wsRoot
 * @returns {{text:string, source:"file"|"builtin"}}
 */
export function loadWechatRules(wsRoot) {
  const file = path.join(String(wsRoot || "."), RULES_REL);
  try {
    const st = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return { text: hit.text, source: "file" };
    // 2026-10-28：注释是给人看的，别每轮塞进模型上下文
    const raw = fs.readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim();
    if (raw) {
      const text = raw.slice(0, 2000);
      cache.set(file, { mtimeMs: st.mtimeMs, text });
      return { text, source: "file" };
    }
  } catch {}
  return { text: DEFAULT_RULES, source: "builtin" };
}

/** 把默认规矩写出来（首次部署用；已存在则不覆盖——用户可能已经改过）。 */
export function seedWechatRules(wsRoot) {
  const file = path.join(String(wsRoot || "."), RULES_REL);
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 20) return { ok: true, existed: true };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        "<!-- 微信里小语的「规矩」。每轮都会读这个文件注入给模型，改了立刻生效（不用改代码）。 -->",
        "<!-- 删掉这个文件会回落到代码里的默认规矩。 -->",
        "",
        DEFAULT_RULES,
        "",
      ].join("\n"),
      "utf8",
    );
    return { ok: true, existed: false };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  }
}
