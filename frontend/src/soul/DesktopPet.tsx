import { useState } from 'react'
import { useCompanionContext } from '../components/xiaoyu/CompanionProvider'
import { GALLERIES, imageForSkin } from '../components/xiaoyu/widget-state.mjs'
import { Block } from './shared'

// 2026-11-18：桌面公仔单独一页。开关、展开方式、立绘只存本机；免打扰与对话页共用同一份偏好。
export default function DesktopPet() {
  const c = useCompanionContext(), [saving,setSaving] = useState(false)
  return <>
    <Block title="桌面显示" hint="只影响这台设备，其他设备各自设置。">
      <label className="soul-check"><input type="checkbox" checked={c.enabled} onChange={e => c.setEnabled(e.target.checked)} />在桌面显示公仔</label>
      <p className="soul-hint">{c.enabled ? '公仔浮在页面上，可拖动位置；点它打开陪伴面板。' : '已关闭：桌面上不显示公仔，也不留收起按钮。对话、情绪和任务照常。'}</p>
      <label className="soul-check"><input type="checkbox" checked={c.hidden} disabled={!c.enabled} onChange={e => c.setHidden(e.target.checked)} />收起成小圆钮</label>
      <p className="soul-hint">收起后只留一个小按钮，点它再展开。</p>
    </Block>
    <Block title="主动打扰" hint="和「情绪与节律」里的免打扰是同一个开关。">
      <label className="soul-check"><input type="checkbox" checked={c.dnd} disabled={saving || !c.preferencesReady} onChange={async e => {setSaving(true); try {await c.setDnd(e.target.checked)} finally {setSaving(false)}}} />陪伴免打扰</label>
      <p className="soul-hint">开启后公仔不再主动冒泡，对话和任务照常。</p>
      {!c.preferencesReady && <p role="status">正在等待可靠的偏好设置，暂不允许修改。</p>}
    </Block>
    <Block title="立绘" hint="选择只影响本机显示。">
      <div className="soul-galleries">{GALLERIES.map(g => <button type="button" key={g.id} aria-pressed={c.skin === g.id} className="soul-gallery" onClick={() => c.chooseSkin(g.id)}>
        <img src={imageForSkin(g.id)} alt="" loading="lazy" /><strong>{g.label}</strong><span>{g.detail}</span><span>{c.skin === g.id ? '正在使用' : '选择这组'}</span>
      </button>)}</div>
    </Block>
  </>
}
