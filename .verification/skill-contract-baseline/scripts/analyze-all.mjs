// 临时：全量扫描服务端用到的 npm 包 + pi 引擎调用方式
import fs from "fs";
import path from "path";
const root = "D:/pi-web";
const dirs = ["engine", "code-mode", "lib", "."];
const exts = [".mjs", ".js", ".cjs"];
const pkgs = new Set();
const piCalls = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (dirs.some(d => p === path.join(root, d) || p.startsWith(path.join(root, d) + path.sep))) walk(p); continue; }
    if (!exts.includes(path.extname(e.name))) continue;
    if (path.dirname(p) !== root && !dirs.some(d => p.startsWith(path.join(root, d)))) continue;
    const s = fs.readFileSync(p, "utf8");
    for (const m of s.matchAll(/(?:from\s+|require\()['"]([^'".\/][^'"]*)['"]/g)) {
      const name = m[1].split("/")[0];
      if (!name.startsWith("node:")) pkgs.add(name);
    }
    if (/spawn|exec/i.test(s) && /pi\b|pi-coding|@earendil/.test(s)) {
      const hits = s.match(/.{0,60}(spawn\w*\([^)]{0,80}|pi-coding-agent|@earendil[\w/-]*){0,3}.{0,40}/g);
      if (hits && hits.length) piCalls.push(path.relative(root, p) + ": " + hits.slice(0,2).join(" | ").replace(/\s+/g," "));
    }
  }
}
walk(root);
console.log("npm 包:", [...pkgs].join(", ") || "无");
console.log("\npi 引擎调用线索（前12条）:");
piCalls.slice(0, 12).forEach(x => console.log("-", x));
