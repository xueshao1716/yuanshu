// 临时：分析服务端外部依赖，评估分发打包范围
import fs from "fs";
import path from "path";

const root = "D:/pi-web";
const files = ["server.mjs", "config.mjs", ...fs.readdirSync(path.join(root, "lib")).filter(f => f.endsWith(".mjs")).map(f => "lib/" + f)];
const all = new Set();
for (const f of files) {
  try {
    const s = fs.readFileSync(path.join(root, f), "utf8");
    for (const m of s.matchAll(/(?:from\s+|require\()['"]([^'".\/][^'"]*)['"]/g)) {
      all.add(m[1].split("/")[0]);
    }
  } catch (e) { console.log("跳过", f, e.message); }
}
console.log("分析文件数:", files.length);
console.log("外部依赖:", [...all].join(", ") || "无");
// 检查 server 是否用到 @lydell/node-pty（原生模块，分发最麻烦）
for (const d of all) console.log(d, "@lydell/node-pty" === d ? "← 原生模块!" : "纯JS");
