// 选项卡片（2026-11-17，学 A2UI 的「卡片代替追问」）：纯函数，组件和测试共用
// 卡片规格：```dsh-ui {"type":"choice","question":"…","options":["A",{"label":"B","desc":"…"}],"custom":true,"skip":true}
export const CHOICE_EVENT = 'pi-chat-reply'
const MAX_OPTIONS = 6, MAX_LABEL = 60, MAX_DESC = 160, MAX_QUESTION = 200

export function normalizeChoice(spec) {
  const question = String(spec?.question || '').trim().slice(0, MAX_QUESTION)
  if (!question) return null
  const seen = new Set()
  const options = []
  for (const raw of Array.isArray(spec?.options) ? spec.options : []) {
    const label = String(typeof raw === 'string' ? raw : raw?.label || '').trim().slice(0, MAX_LABEL)
    if (!label || seen.has(label)) continue
    seen.add(label)
    const desc = typeof raw === 'object' && raw ? String(raw.desc || '').trim().slice(0, MAX_DESC) : ''
    options.push(desc ? { label, desc } : { label })
    if (options.length >= MAX_OPTIONS) break
  }
  if (options.length < 2) return null
  return { question, options, custom: spec?.custom !== false, skip: spec?.skip !== false }
}

export function choiceReplyText({ question, label, custom, skip }) {
  const q = `关于「${String(question || '').trim()}」：`
  if (skip) return `${q}跳过这个问题，你按自己的判断来`
  if (label) return `${q}我选「${label}」`
  const text = String(custom || '').trim()
  return text ? q + text : ''
}
