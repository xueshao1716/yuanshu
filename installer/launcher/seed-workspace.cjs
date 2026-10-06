// 工作区种子：把 template/workspace 里缺的文件补进用户工作区，已有的一律不动。
// 第一次装 = 带人格定义与基因基线的完整初始工作区；升级/重装 = 不碰任何已有数据。
"use strict";
const path = require("node:path");
const fs = require("node:fs");

function seedWorkspace(templateDir, wsRoot) {
  const created = [];
  if (!fs.existsSync(templateDir)) return created;
  const walk = (rel) => {
    for (const ent of fs.readdirSync(path.join(templateDir, rel), { withFileTypes: true })) {
      const r = path.join(rel, ent.name);
      const dst = path.join(wsRoot, r);
      if (ent.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); walk(r); continue; }
      if (fs.existsSync(dst)) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(templateDir, r), dst, fs.constants.COPYFILE_EXCL);
      created.push(r);
    }
  };
  fs.mkdirSync(wsRoot, { recursive: true });
  walk("");
  return created;
}

module.exports = { seedWorkspace };
