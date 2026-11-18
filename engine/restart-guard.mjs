// 2026-11-18：重启自动续的熔断。
// 新电脑一开始挂了四五个会话把机器拖死，重启后自动续又把它们一起拉起来，再次卡死——死循环。
// 规则：上一次启动做过自动续，且距今不到 LOOP_WINDOW_MS 又重启了，就当作"续跑把服务拖垮"，这次不自动续，留给人手动继续。
import fs from 'node:fs'
import path from 'node:path'

export const LOOP_WINDOW_MS = 10 * 60_000
// 一次重启最多自动续几个主对话；其余留给手动继续
export const RESTART_BATCH = 2
// 相邻两个自动续之间错开的间隔
export const RESTART_STAGGER_MS = 20_000

export function createRestartGuard(dir, now = Date.now()) {
  const file = path.join(dir, '.restart-guard.json')
  let prev = null
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  const prevAt = Date.parse(prev?.bootAt)
  const loop = Boolean(prev?.autoResumed) && Number.isFinite(prevAt) && now - prevAt < LOOP_WINDOW_MS
  const state = { bootAt: new Date(now).toISOString(), autoResumed: false, heldForLoop: loop }
  const save = () => { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(state)) } catch {} }
  save()
  return {
    // true = 这次启动允许自动续
    allowAutoResume: () => !loop,
    markAutoResumed() { if (!state.autoResumed) { state.autoResumed = true; save() } },
  }
}
