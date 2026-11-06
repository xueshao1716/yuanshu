// ===== media-mode.mjs —— 出图由谁发起（2026-10-28）=====
//
// 用户：「画是对的，但是得她驱动着去画，而不是直接出图模型开干了」
//
// 旧行为：server 在模型之前用关键词检测直接调出图 API（宿主抢跑）。
// 新行为（默认）：让模型自己调 generate_image；宿主的抢跑留作开关兜底。
//
// 开关：<ws>/记忆/运行时/出图.json
//   { "direct": true }   → 回到抢跑（模型不调工具时也能出图）
//   { "direct": false }  → 她驱动（默认）
import fs from "node:fs";
import path from "node:path";

export const MODE_REL = path.join("记忆", "运行时", "出图.json");

export function directMediaMode(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(String(wsRoot || "."), MODE_REL), "utf8"));
    return raw && raw.direct === true;
  } catch {}
  return false; // 默认她驱动
}

export function seedMediaMode(wsRoot, direct = false) {
  const file = path.join(String(wsRoot || "."), MODE_REL);
  try {
    if (fs.existsSync(file)) return { ok: true, existed: true };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ direct, note: "direct=true 宿主抢跑（关键词直接出图）；false 让小语自己调 generate_image" }, null, 2), "utf8");
    return { ok: true, existed: false };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) } }
}
