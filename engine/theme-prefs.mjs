// ══════════════════════════════════════════════════════════
// engine/theme-prefs.mjs —— 主题偏好跨端持久化（2026-08-26）
// 目的：一端更新主题/主色 → 其他端打开拉取一致（不再各端 localStorage 各自为政）
// 存储：AGENT_DIR/theme-prefs.json（原子写）；默认 theme=mist 对齐前端
// ══════════════════════════════════════════════════════════
import fs from "node:fs"
import { atomicWriteJson } from "./atomic-io.mjs"

let _file = ""

// 层级密度按主题分别记（2026-11-17）：{ 主题id: step }，只收合法 id 与精调滑块范围内的数
function cleanDensities(o) {
  const out = {}
  if (!o || typeof o !== "object") return out
  for (const [k, v] of Object.entries(o).slice(0, 40)) {
    if (/^[a-z][a-z-]{0,23}$/.test(k) && typeof v === "number" && v >= 0.02 && v <= 0.08) out[k] = v
  }
  return out
}

export function initThemePrefs(file) {
  _file = file
}

// 读：返回 { theme, accent, wallpaper, densities }；无文件/残缺 → 给默认
export function loadThemePrefs() {
  try {
    if (_file && fs.existsSync(_file)) {
      const o = JSON.parse(fs.readFileSync(_file, "utf8"))
      return { theme: String(o.theme || "mist"), accent: String(o.accent || ""), wallpaper: String(o.wallpaper || ""), densities: cleanDensities(o.densities) }
    }
  } catch {}
  return { theme: "mist", accent: "", wallpaper: "", densities: {} }
}

// 写：白名单字段，原子写；返回规范化对象
export function saveThemePrefs(obj) {
  const prev = loadThemePrefs()
  const hasWallpaper = Object.prototype.hasOwnProperty.call(obj || {}, "wallpaper")
  const t = {
    theme: String(obj?.theme || prev.theme || "mist"),
    accent: typeof obj?.accent === "string" ? obj.accent : prev.accent,
    wallpaper: hasWallpaper ? String(obj.wallpaper || "") : prev.wallpaper,
    densities: obj?.densities !== undefined ? cleanDensities(obj.densities) : prev.densities,
  }
  if (_file) { try { atomicWriteJson(_file, t) } catch {} }
  return t
}
