// 临时：查 engine 里怎么调用 pi 引擎（spawn 哪个命令）
import fs from "fs";
const files = fs.readdirSync("engine").filter(f => f.endsWith(".mjs"));
for (const f of files) {
  const s = fs.readFileSync("engine/" + f, "utf8");
  const m = s.match(/.{0,150}(spawn|execFile)\w*\(.{0,200}/);
  if (m && /pi|node|npm|npx/.test(m[0])) {
    console.log("=== " + f + " ===");
    console.log(m[0].replace(/\s+/g, " ").slice(0, 350));
  }
}
// bin/pi-agent.mjs 头部
console.log("=== bin/pi-agent.mjs 头部 ===");
console.log(fs.readFileSync("bin/pi-agent.mjs", "utf8").slice(0, 500));
