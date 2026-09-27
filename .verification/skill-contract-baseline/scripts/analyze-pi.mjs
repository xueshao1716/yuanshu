// 临时：找 pi 引擎真正调用点（会话/聊天层）
import fs from "fs";
import path from "path";
function walk(dir, cb) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "android" || e.name === "app" || e.name === "target" || e.name === "生成物") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, cb);
    else if (/\.(mjs|cjs|js)$/.test(e.name)) cb(p);
  }
}
const hits = [];
walk("D:/pi-web", p => {
  const s = fs.readFileSync(p, "utf8");
  if (/pi-coding-agent|@earendil|createAgent|pi.*SDK/i.test(s) && !p.includes("android") && !p.includes("app")) {
    const lines = s.split("\n").map((l, i) => /pi-coding-agent|@earendil/.test(l) ? `${p}:${i + 1}: ${l.trim().slice(0, 120)}` : null).filter(Boolean);
    hits.push(...lines);
  }
});
console.log(hits.slice(0, 30).join("\n") || "未找到直接引用");
