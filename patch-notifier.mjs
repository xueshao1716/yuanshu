import fs from "node:fs";
const p = "D:/pi-web/engine/notifier.mjs";
let s = fs.readFileSync(p, "utf8");
// 精确锚点：微信 catch 行 + }  + return result
const lines = s.split("\n");
const targetIdx = lines.findIndex(l => l.includes("log.warn?.(`[notifier] 微信通知失败"));
if (targetIdx === -1) { console.log("find warn line..."); process.exit(1); }
// 结构: lines[targetIdx]=catch, lines[targetIdx+1]="    }", lines[targetIdx+2]="    return result;"
// 在 targetIdx+1 ("    }") 之后插入 pushplus 支路，把 return result 推到后面
const insert = [
  "    }",
  "    // PushPlus 支路（独立并行，不影响微信通道）",
  "    {",
  "      const ppToken = ppReadToken(wsRoot);",
  "      if (ppToken) {",
  "        try {",
  "          await ppSend(ppToken, t, b.length > 1000 ? b.slice(0, 1000) : b);",
  "          result.pushplus = \"sent\";",
  "        } catch {",
  "          result.pushplus = \"failed\";",
  "        }",
  "      } else {",
  "        result.pushplus = \"skipped\";",
  "      }",
  "    }",
].join("\n");
// 替换 lines[targetIdx+1] (就是 "    }") 为整个 insert
lines[targetIdx+1] = insert;
s = lines.join("\n");
fs.writeFileSync(p, s, "utf8");
console.log("patched ok, line", targetIdx+1);
