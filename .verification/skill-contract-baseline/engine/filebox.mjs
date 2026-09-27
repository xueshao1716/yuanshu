// 元枢文件盒：文件服务（查找/元数据/传输/交付）
// 架构：pi 只理解意图并下指令（search_files/deliver），本地系统执行查找与传输
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";

// 签名密钥（进程随机，重启后旧链接自然过期——符合"临时链接"语义）
const SECRET = crypto.randomBytes(16).toString("hex");
const TTL_MS = 24 * 3600 * 1000; // 签名 24h 有效

// 生成带签名的下载 URL（相对路径，可下载可预览）
export function signedUrl(relPath, download = false) {
  const enc = encodeURIComponent(relPath);
  const exp = Date.now() + TTL_MS;
  // 注意：URLSearchParams.get 会自动解码，所以签名对象必须是原始路径
  const sig = crypto.createHmac("sha256", SECRET).update(`${relPath}:${exp}`).digest("hex").slice(0, 16);
  return `/api/ws/file?path=${enc}&exp=${exp}&sig=${sig}${download ? "&download=1" : ""}`;
}

// 校验签名 URL，返回相对路径或 null
export function verifySigned(req) {
  try {
    const u = new URL(req.url, "http://localhost");
    const rel = u.searchParams.get("path"); // 已自动解码
    const exp = parseInt(u.searchParams.get("exp") || "0", 10);
    const sig = u.searchParams.get("sig") || "";
    if (!rel || !exp || !sig) return { ok: false, reason: "缺参数" };
    if (Date.now() > exp) return { ok: false, reason: "链接已过期" };
    const expect = crypto.createHmac("sha256", SECRET).update(`${rel}:${exp}`).digest("hex").slice(0, 16);
    if (sig !== expect) return { ok: false, reason: "签名无效" };
    return { ok: true, rel };
  } catch { return { ok: false, reason: "解析失败" }; }
}

// 生成图片缩略图（用 Python PIL，Windows 兼容），返回相对路径
// 同步返回预期路径（异步生成），首次访问可能还没生成，前端可回退原图
export function makeThumb(relPath, wsRoot) {
  try {
    const abs = path.resolve(wsRoot, relPath);
    if (!fs.existsSync(abs)) return null;
    const ext = path.extname(abs).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"].includes(ext)) return null;
    const dir = path.join(wsRoot, ".thumbs");
    fs.mkdirSync(dir, { recursive: true });
    const thumbName = path.basename(abs, ext) + "-thumb.jpg";
    const thumbAbs = path.join(dir, thumbName);
    const rel = path.relative(wsRoot, thumbAbs).replace(/\\/g, "/");
    if (fs.existsSync(thumbAbs) && fs.statSync(thumbAbs).mtimeMs >= fs.statSync(abs).mtimeMs) {
      return rel;
    }
    const py = `from PIL import Image; im=Image.open(r"${abs}"); im.thumbnail((480,480)); im.convert("RGB").save(r"${thumbAbs}", quality=80)`;
    execFile("python", ["-c", py], { timeout: 15000, windowsHide: true }, (err) => {
      if (err) console.log(`[filebox] 缩略图生成失败: ${String(err.message||err).slice(0,60)}`);
      else console.log(`[filebox] 缩略图: ${thumbAbs}`);
    });
    return rel;
  } catch { return null; }
}

// ══ 智能文件查找（独立文件系统的核心：pi 下指令 → 本地执行查找）══
const SKIP_DIRS = new Set(["node_modules", ".git", ".thumbs", "backups", ".cache", "temp", "tmp", "__pycache__", ".venv", "logs"]);
// 成品优先级：网页/文档/图片 > 演示/压缩/媒体 > 代码 > 其他
function typePriority(name) {
  const e = path.extname(name).toLowerCase();
  if (/^\.(html?|md|pdf|png|jpe?g|gif|webp)$/.test(e)) return 0;
  if (/^\.(pptx?|docx?|zip|mp4|svg|json)$/.test(e)) return 1;
  if (/^\.(js|css|py|txt|ts)$/.test(e)) return 2;
  return 3;
}

// 查找工作空间文件
// opts: { query, types: ['.png'], max, keywordWeight, recentFirst }
export function findFiles(wsRoot, opts = {}) {
  try {
    const root = path.resolve(wsRoot);
    if (!fs.existsSync(root)) return [];
    const { query = "", types = null, max = 8, maxDepth = 5 } = opts;
    const out = [];
    // 提取关键词：分词（空格/逗号/顿号），去掉虚词
    const raw = String(query || "").toLowerCase();
    const kws = raw.split(/[\s、，,，.。:：]+/).map(s => s.replace(/[发给我你它他她他们一下看个这那张张那些最最近做了的的地得把请帮忙]/g, "")).filter(s => s.length >= 2);
    const walk = (dir, depth) => {
      if (depth > maxDepth || out.length >= max * 4) return;
      let items;
      try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const it of items) {
        if (it.name.startsWith(".") || it.name.startsWith("_")) continue;
        if (SKIP_DIRS.has(it.name)) continue;
        const full = path.join(dir, it.name);
        if (it.isDirectory()) { walk(full, depth + 1); continue; }
        const ext = path.extname(it.name).toLowerCase();
        if (types && !types.includes(ext)) continue;
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        const rel = path.relative(root, full).split("\\").join("/");
        const nameLower = it.name.toLowerCase();
        const relLower = rel.toLowerCase();
        let score = 0;
        if (kws.length) {
          for (const k of kws) {
            if (nameLower.includes(k)) score += 3;
            else if (relLower.includes(k)) score += 2;
          }
          if (score === 0) continue; // 有关键词但完全没命中 → 跳过
        }
        out.push({ name: it.name, path: rel, size: st.size, mime: "", mtimeMs: st.mtimeMs, score });
      }
    };
    walk(root, 0);
    // 排序：关键词命中 > 成品优先级 > 最近修改
    return out.sort((a, b) =>
      (b.score || 0) - (a.score || 0) ||
      typePriority(a.name) - typePriority(b.name) ||
      (b.mtimeMs || 0) - (a.mtimeMs || 0)
    ).slice(0, max);
  } catch { return []; }
}

// 查找结果 → 给 pi 的文本摘要（工具返回）
export function findResultText(files, wsRoot) {
  if (!files.length) return "未找到匹配的文件。可尝试：放宽关键词、检查文件名拼写，或用 read 工具列出目录。";
  const lines = files.map((f, i) => `${i + 1}. ${f.name}（${f.path}）`).join("\n");
  return `找到 ${files.length} 个文件：\n${lines}\n\n用户要交付哪个？直接用 deliver 标记（📎 交付: 路径）交付。`;
}
