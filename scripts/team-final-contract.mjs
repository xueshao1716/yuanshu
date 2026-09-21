// Keep the live video runner honest about its required delivery contract.
// A model may omit short, easy-to-forget fields even when the prompt lists them.
// We repair only contract metadata from the model draft and explicit safety defaults;
// shots and creative content are never invented here.

const clean = value => String(value ?? '').trim()
const list = value => Array.isArray(value) ? value.map(clean).filter(Boolean) : []

export function formatShotSeconds(value) {
  const label = clean(value)
  return /(?:s|秒)$/i.test(label) ? label : `${label}s`
}

const DEFAULT_NEGATIVE = [
  '人物、手部或肢体畸变，多余手指和穿帮',
  '视频模型直接生成中文导致错字、乱码或水印',
  '跨镜人物外观、服装、道具和光线漂移',
  '主体或关键动作跑出 9:16 画面安全区',
  '未授权音乐、危险无保护动作或可模仿的高风险示范',
]

const DEFAULT_TEXT_HANDLING = '视频模型不直接生成中文；如需字幕，后期使用已校对的中文文本叠加，统一字体、位置、字号与出入时机。'
const DEFAULT_DO_NOT_DO = [
  '不使用无保护真实腾空或可模仿的危险动作',
  '不混用 9:16 以外的画幅，不让观众、杂乱背景或第二主体抢占安全区',
  '不使用未授权音乐、现成影视角色或未授权品牌元素',
]

export function repairVideoFinal({ final = {}, draft = {}, task = '' } = {}) {
  const out = { ...(final && typeof final === 'object' ? final : {}) }
  const repairs = []

  if (!clean(out.aspect)) {
    out.aspect = clean(draft.aspect) || '9:16'
    repairs.push('终稿补回画幅')
  }
  if (out.total_sec == null || !Number.isFinite(Number(out.total_sec))) {
    if (Number.isFinite(Number(draft.total_sec))) out.total_sec = Number(draft.total_sec)
    else out.total_sec = 10
    repairs.push('终稿补回总时长')
  }

  const consistencyKey = clean(out.consistencyKey) || clean(draft.consistencyKey)
  if (consistencyKey) out.consistencyKey = consistencyKey.slice(0, 160)
  else {
    out.consistencyKey = `同一主体跨镜保持外观、服装、道具、动作逻辑与光线连续（${clean(task).slice(0, 36) || '本任务'}）`
    repairs.push('终稿补回一致性键')
  }

  const negatives = [...list(out.negative), ...list(draft.negative)]
  for (const item of DEFAULT_NEGATIVE) if (!negatives.includes(item)) negatives.push(item)
  if (!list(out.negative).length || !DEFAULT_NEGATIVE.every(item => list(out.negative).includes(item))) repairs.push('终稿补回负面清单')
  out.negative = [...new Set(negatives)].slice(0, 10)

  if (!clean(out.text_handling)) {
    out.text_handling = clean(draft.text_handling) || DEFAULT_TEXT_HANDLING
    repairs.push('终稿补回文字处理方案')
  }

  const doNotDo = [...list(out.doNotDo), ...list(draft.doNotDo)]
  for (const item of DEFAULT_DO_NOT_DO) if (!doNotDo.includes(item)) doNotDo.push(item)
  if (!list(out.doNotDo).length || !DEFAULT_DO_NOT_DO.every(item => list(out.doNotDo).includes(item))) repairs.push('终稿补回平台与安全约束')
  out.doNotDo = [...new Set(doNotDo)].slice(0, 8)

  return { final: out, repairs }
}

export { DEFAULT_NEGATIVE, DEFAULT_TEXT_HANDLING, DEFAULT_DO_NOT_DO }
