from pathlib import Path
p=Path(r'D:\pi-web\engine\workspace-api.mjs')
s=p.read_text(encoding='utf-8')
old='''      fs.writeFileSync(file, buf);
    } else {
      return artifact.url;
    }
    console.log(`[pi-web] 产物已落盘: ${file}`);'''
new='''      fs.writeFileSync(file, buf);
    } else {
      return artifact.url;
    }
    if (artifact.meta && typeof artifact.meta === "object") {
      try {
        fs.writeFileSync(file + ".meta.json", JSON.stringify({ ...artifact.meta, createdAt: new Date().toISOString() }, null, 2), "utf8");
      } catch {}
    }
    console.log(`[pi-web] 产物已落盘: ${file}`);'''
assert old in s
s=s.replace(old,new,1)
old2='''  const push = (fp, type, date) => {
    try {
      if (!fs.statSync(fp).isFile()) return;
      out.push({
        name: path.basename(fp), type, date,
        path: path.relative(WS_ROOT, fp).replace(/\\\\/g, "/"),
        size: fs.statSync(fp).size,
        url: `/api/ws/file?path=${encodeURIComponent(fp)}`,
      });
    } catch {}
  };'''
new2='''  const push = (fp, type, date) => {
    try {
      if (!fs.statSync(fp).isFile() || fp.endsWith(".meta.json")) return;
      const meta = readJsonSidecar(fp + ".meta.json");
      out.push({
        name: path.basename(fp), type, date,
        path: path.relative(WS_ROOT, fp).replace(/\\\\/g, "/"),
        size: fs.statSync(fp).size,
        url: `/api/ws/file?path=${encodeURIComponent(fp)}`,
        ...(meta ? { meta } : {}),
      });
    } catch {}
  };'''
assert old2 in s, 'push target not found'
s=s.replace(old2,new2,1)
marker='// GET /api/ws/artifacts —— 生成物列表（按类型/日期）'
assert marker in s
s=s.replace(marker,'''function readJsonSidecar(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

'''+marker,1)
p.write_text(s,encoding='utf-8')
