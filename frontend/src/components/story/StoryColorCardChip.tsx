import { resolveColorCard, colorCardGradient, CARD_FAMILIES } from '../../theme/colorcards.mjs'

// 配色卡示意缩略图（2026-09-16）。
//
// 为什么要有它：配色卡进了提示词以后，界面上只剩一行「#6453A1 → #FDDCE4」——
// 一组 hex 看不出"这套色落在画面里是什么感觉"。这里把它变回一块渐变，
// 写提示词的人一眼就知道这一次发出去会落在什么色上。
//
// 两种情况必须分得清：没写色调的段落是**按整片配色**走，写了的段落是**破格**。
// 混在一起显示会让人以为整片都改了。
export default function StoryColorCardChip({ colorCardId, toneOverride = '', note = '', global = false }: { colorCardId?: string; toneOverride?: string; note?: string; global?: boolean }) {
  const card = resolveColorCard(colorCardId) as { id: string; name: string; top: string; bottom: string; family?: string } | null
  if (!card) return null
  const override = String(toneOverride || '').trim()
  const family = (CARD_FAMILIES as any)[card.family || 'morandi']?.short || ''
  return (
    <div className="story-color-chip" data-color-card={card.id}>
      <span className="story-color-chip-swatch" style={{ background: colorCardGradient(card) }} aria-hidden="true" />
      <span className="story-color-chip-text">
        <strong>配色 · {card.name}{family ? `（${family}）` : ''}{global ? ' · 跟随全局' : ''}</strong>
        <span className="story-color-chip-hex">{card.top} → {card.bottom} · 竖向渐变、上深下浅</span>
        {override
          ? <em className="story-color-chip-override">这一段破格：{override}</em>
          : <em className="story-color-chip-inherit">{note || '这一段按整片配色写「色调」'}</em>}
      </span>
    </div>
  )
}
