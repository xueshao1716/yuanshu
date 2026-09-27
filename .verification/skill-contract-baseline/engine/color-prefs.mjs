// ══════════════════════════════════════════════════════════
// engine/color-prefs.mjs —— 全局创作配色卡（2026-09-16）
//
// 为什么要有它：配色卡一开始只挂在"连续创作项目"上（project.colorCardId），
// 于是绘画工坊、视频工坊、聊天里出图、批量生成**都吃不到**——选了一套色，
// 只有那一个项目里的画面按它走。这里把它升成**全局偏好**（跨端、跨工作台一份）：
// 所有出图/出片的入口都按它写「色调」，项目要用别的色再单独覆盖。
//
// 存储：AGENT_DIR/color-prefs.json（原子写）。默认空 = 不指定，绝不替用户默认一套。
// ══════════════════════════════════════════════════════════
import fs from "node:fs"
import { atomicWriteJson } from "./atomic-io.mjs"
import { resolveColorCard } from "./color-cards.mjs"

let _file = ""

export function initColorPrefs(file) {
  _file = file
}

// 读：返回规范化后的 { colorCardId }（认不出来的 id 一律当没选，不留脏数据）
export function loadColorPrefs() {
  try {
    if (_file && fs.existsSync(_file)) {
      const o = JSON.parse(fs.readFileSync(_file, "utf8"))
      const id = String(o?.colorCardId || "")
      return { colorCardId: resolveColorCard(id) ? id : "" }
    }
  } catch {}
  return { colorCardId: "" }
}

// 直接取"当前生效的那张卡"（没有就是 null）
export function currentColorCard() {
  return resolveColorCard(loadColorPrefs().colorCardId)
}

// 写：白名单字段，原子写；认不出来的 id 直接拒绝，别写进文件
export function saveColorPrefs(obj = {}) {
  const raw = String(obj?.colorCardId || "")
  const id = raw && resolveColorCard(raw) ? raw : ""
  const next = { colorCardId: id }
  if (_file) { try { atomicWriteJson(_file, next) } catch {} }
  return next
}
