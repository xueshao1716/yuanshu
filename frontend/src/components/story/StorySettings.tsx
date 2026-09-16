import { withFileToken } from '../../api'
import { STYLE_PRESETS, stylePresetById } from '../../lib/story-styles'
import { MORANDI_CARDS, colorCardGradient } from '../../theme/colorcards.mjs'
import type { StoryCharacter } from '../../types'

type AssetKind = 'character' | 'location' | 'prop'
interface RefAsset { id: string; name?: string; refImage?: string }

// 人物与连续性设定。角色区额外提供「定妆照」：生成后写回 bible.characters[].refImage，
// 后续画面/视频会把它当作**真实的参考图**注入（图像走图生图、视频走 reference 模式），
// 这是"锁住人物外貌"的入口——在此之前 story 层只有文字描述。
//
// 2026-09-15 扩展：**场景与道具也走同一条通路**。此前只有角色有参考图，场景/道具只有文字，
// 同一间屋子在两段里会长得不一样（对手产品都在解决：PINNGOO 叫资产库，LibTV 叫角色三视图+资产复用）。
// 挂载规则和角色一样：名字出现在这一段的提示词里，就带上它的参考图。
//
// 2026-09-16：参考图也是"产物"，所以**同样受本地化契约约束**（docs/NAMING.md 第三节）——
// 入库时下载失败的会留下外站临时链接，定妆照挂在会过期的地址上，几天后人物一致性就悄悄失效。
// 这里标出哪些还是外链，并给一个把外站产物都拉到本地的入口。
export default function StorySettings({ values, busy, characters, locations = [], props = [], externalAssets = 0, colorCardId = '', onPortrait, onAssetRef, onLocalizeAll, onColorCard, onChange, onSave }: {
  values: Record<string, string>
  busy: boolean
  characters: StoryCharacter[]
  locations?: RefAsset[]
  props?: RefAsset[]
  externalAssets?: number
  colorCardId?: string
  onPortrait: (character: StoryCharacter, lookName?: string) => void
  onAssetRef?: (assetType: AssetKind, asset: RefAsset) => void
  onLocalizeAll?: () => void
  onColorCard?: (colorCardId: string) => void
  onChange: (values: Record<string, string>) => void
  onSave: () => void
}) {
  const isExternal = (url?: string) => /^https?:/i.test(String(url || ''))
  const withRef = characters.filter(c => c.refImage).length
  const groups: { key: AssetKind; label: string; list: RefAsset[]; hint: string; cta: string }[] = [
    { key: 'character', label: '角色定妆照', list: characters, hint: '锁住人物外貌', cta: '生成定妆照' },
    { key: 'location', label: '场景参考图', list: locations, hint: '锁住"同一个地方"的样子，避免环境漂移', cta: '生成场景图' },
    { key: 'prop', label: '道具参考图', list: props, hint: '锁住关键道具的材质与细节', cta: '生成道具图' },
  ]
  return <details className="story-settings"><summary>人物与连续性设定 <span>每一段都会使用，展开修改</span></summary>
    {externalAssets > 0 && <div className="story-external">
      <span>有 <strong>{externalAssets}</strong> 个产物还挂在外站临时链接上（会过期）。参考图与产出都算在内。</span>
      <button type="button" className="btn-ghost" disabled={busy || !onLocalizeAll} onClick={onLocalizeAll}>把外站的产物拉到本地</button>
    </div>}
    {groups.filter(g => g.list.length > 0).map(g => {
      const n = g.list.filter(x => x.refImage).length
      return <div key={g.key} className="story-portraits">
        <div className="story-portraits-head">
          <strong>{g.label}</strong>
          <span className="story-hint">{g.hint}（已有 {n}/{g.list.length}）</span>
        </div>
        <div className="story-portrait-list">{g.list.map(item => {
          // 角色可能有多张形象（基础形象/战斗装束…）：每张单独生成，卡片上标出「已添加形象 N/M」。
          // 只锁一张脸不够——换装段落没有对应形象图，模型只能靠文字猜，一致性立刻掉。
          const looks = g.key === 'character' && Array.isArray((item as any).looks) ? (item as any).looks as { id?: string; name?: string; refImage?: string }[] : []
          const done = looks.filter(l => l.refImage).length
          const shown = looks.length ? (looks[0].refImage || item.refImage) : item.refImage
          return <div key={item.id} className="story-portrait-card">
            {shown
              ? <img src={withFileToken(String(shown))} alt={`${item.name || item.id} 的参考图`} />
              : <div className="story-portrait-empty" aria-hidden="true">未生成</div>}
            <strong title={item.name || item.id}>{item.name || item.id}</strong>
            {looks.length > 0 && <span className="story-hint">已添加形象 {done}/{looks.length}</span>}
            {isExternal(item.refImage) && <span className="story-portrait-warn">外链 · 会过期</span>}
            {/* 形象自成一组（2026-09-16 视觉整理）：标题 + 形象芯片 + 「新增形象」同排，
                和下面的「重新生成」分开。混在一行时看不出"哪几个是形象、哪个是新增"，
                也看不出点一下是重新生成**哪一张**。 */}
            {g.key === 'character' && <div className="story-look-row">
              <span className="story-look-title">形象</span>
              <div className="story-look-list">
                {looks.map(l => (
                  <span key={l.id || l.name} className={`story-look${l.refImage ? ' is-done' : ''}`} title={l.refImage ? '已生成' : '还没生成'}>
                    <button type="button" className="story-look-btn" disabled={busy}
                      onClick={() => onPortrait(item as StoryCharacter, l.name)}>{l.name || '形象'}</button>
                  </span>
                ))}
                {looks.length === 0 && <span className="story-hint">还没有形象变体</span>}
                <button type="button" className="story-look-add" disabled={busy}
                  title="换装、雨夜、便装……每种形象各生成一张；换装段落才有一致的参考图"
                  onClick={() => { const name = window.prompt('新形象叫什么？（例如：战斗装束 / 便装 / 雨夜）', ''); if (name && name.trim()) onPortrait(item as StoryCharacter, name.trim()) }}>
                  ＋ 新增形象
                </button>
              </div>
              {looks.length > 0 && <span className="story-hint">已生成 {done}/{looks.length}</span>}
            </div>}
            <div className="story-actions">
              <button type="button" className="btn-ghost" disabled={busy}
                title={g.key === 'character' ? '重新生成基础形象（脸与体格的那张基准图）' : undefined}
                onClick={() => (g.key === 'character' ? onPortrait(item as StoryCharacter) : onAssetRef?.(g.key, item))}>
                {item.refImage ? '重新生成' : g.cta}
              </button>
            </div>
          </div>
        })}</div>
      </div>
    })}
    {characters.length > 0 && withRef < characters.length && <p className="story-hint">还没有定妆照的角色只能靠文字描述，人物一致性会差很多。</p>}
    {/* 风格预设：把"这部戏长什么样"从自由发挥变成可选的统一画风——
        画风一旦漂移，人物锁得再准也救不回来 */}
    <div className="story-style-presets">
      <label>统一画风<select aria-label="风格预设" disabled={busy} defaultValue=""
        onChange={e => { const p = stylePresetById(e.target.value); if (p) onChange({ ...values, style: `${p.visual}；${p.tone}（${p.name}）` }) }}>
        <option value="">选一个预设填进「文字与画面风格」</option>
        {STYLE_PRESETS.map(p => <option key={p.id} value={p.id}>{p.name}（{p.tags.join('/')}）</option>)}
      </select></label>
      <span className="story-hint">预置了 {STYLE_PRESETS.length} 种画风，选完仍可手改</span>
    </div>
    {/* 配色卡（2026-09-16）：画风决定"长什么样"，配色决定"是什么颜色"。
        选中的卡会写进 project.colorCardId，由编排层编译进每一段的「色调」槽——
        所以它是整部戏的，不是某一段的；不选就什么都不加，绝不替用户默认一套。 */}
    <div className="story-color-cards">
      <div className="story-color-cards-head">
        <strong>配色卡</strong>
        <span className="story-hint">
          {colorCardId
            ? `已选「${MORANDI_CARDS.find(c => c.id === colorCardId)?.name || colorCardId}」，每一镜的提示词都会按它写色调`
            : `莫兰迪高级灰 ${MORANDI_CARDS.length} 组，选了就写进画面/视频提示词的「色调」`}
        </span>
      </div>
      <div className="story-color-card-list">
        <button type="button" className={`story-color-card-none${colorCardId ? '' : ' is-active'}`} disabled={busy}
          aria-pressed={!colorCardId} onClick={() => onColorCard?.('')}>不指定</button>
        {MORANDI_CARDS.map(card => {
          const active = colorCardId === card.id
          return <button
            key={card.id}
            type="button"
            disabled={busy}
            aria-pressed={active}
            aria-label={`配色卡 ${card.name}：${card.top} 到 ${card.bottom}`}
            title={`${card.top} → ${card.bottom}`}
            className={`story-color-card${active ? ' is-active' : ''}`}
            onClick={() => onColorCard?.(card.id)}
          >
            <span className="story-color-card-swatch" style={{ background: colorCardGradient(card) }} />
            <span className="story-color-card-name">{card.name}</span>
          </button>
        })}
      </div>
    </div>
    <div className="story-settings-grid">{[['characters','人物与外貌'],['locations','场景'],['wardrobe','服装'],['props','道具'],['rules','必须遵守的规则'],['style','文字与画面风格']].map(([key,label]) => <label key={key}>{label}<textarea value={values[key] || ''} rows={3} disabled={busy} onChange={e => onChange({ ...values, [key]: e.target.value })} placeholder={`补充${label}`} /></label>)}</div>
    <button className="btn-ghost" disabled={busy} onClick={onSave}>保存设定</button>
  </details>
}
