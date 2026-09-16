// 全局创作配色卡的**壳层**落地（2026-09-16）。
//
// 起因：用户问"全局不应该左侧栏、右侧栏也带一些效果吗"——选了一套色，如果只有出图变了、
// 界面还是原来的灰，那"全局"就只是一句宣传。这里把卡的色纱挂到 documentElement 的 CSS 变量上，
// 由 styles.css 的 `body.has-color-card` 规则贴到左栏/右栏/面板头（浓度见 engine 的 SHELL_TINT）。
//
// 浓度故意压得很低：壳层的字色 token 一个都没改，色纱只是叠在底色之上，
// 18 张卡 × 11 套主题都不该让正文掉到 AA 线以下——那条线由 theme-contrast 测试守着。
import { resolveColorCard, colorCardShellVars } from './colorcards.mjs'

const KEYS = ['--pi-card-top', '--pi-card-bottom', '--pi-card-shell-left', '--pi-card-shell-right', '--pi-card-shell-top']
const LS_KEY = 'pi_color_card'

export function applyColorCardShell(cardId) {
  if (typeof document === 'undefined') return
  const el = document.documentElement
  for (const key of KEYS) el.style.removeProperty(key)
  const card = resolveColorCard(cardId)
  if (!card) {
    document.body.classList.remove('has-color-card')
    delete el.dataset.colorCard
    return
  }
  for (const [key, value] of Object.entries(colorCardShellVars(card))) el.style.setProperty(key, value)
  document.body.classList.add('has-color-card')
  el.dataset.colorCard = card.id
}

export function currentColorCardShell() {
  try { return localStorage.getItem(LS_KEY) || '' } catch { return '' }
}

// 写本地 + 立刻生效 + 广播（其它组件/两端同步用）
export function persistColorCardShell(cardId) {
  const id = String(cardId || '')
  try { id ? localStorage.setItem(LS_KEY, id) : localStorage.removeItem(LS_KEY) } catch {}
  applyColorCardShell(id)
  try { window.dispatchEvent(new CustomEvent('pi-color-card-changed', { detail: { cardId: id } })) } catch {}
}
