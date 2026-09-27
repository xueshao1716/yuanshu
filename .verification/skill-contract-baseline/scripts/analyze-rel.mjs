// 临时：列出 server.mjs / lib 的相对导入 + pi 引擎调用方式
import fs from "fs";
import path from "path";
const root = "D:/pi-web";
for (const f of ["server.mjs", ...fs.readdirSync(path.join(root,"lib")).filter(x=>x.endsWith(".mjs")).map(x=>"lib/"+x)]) {
  const s = fs.readFileSync(path.join(root,f),"utf8");
  const rel = [...s.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map(m=>m[1]);
  const pi = [...s.matchAll(/(pi-coding-agent|@earendil[\w/-]*|engine[\/\\][\w.-]+)/g)].map(m=>m[1]);
  console.log(f, "| 相对导入:", rel.join(", ")||"无", "| pi相关:", [...new Set(pi)].join(", ")||"无");
}
console.log("--- lib 目录 ---");
console.log(fs.readdirSync(path.join(root,"lib")).join("\n"));
