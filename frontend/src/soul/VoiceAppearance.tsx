import { SpeechSettings } from '../components/SpeechSettings'
import { useCompanionContext } from '../components/xiaoyu/CompanionProvider'
import { GALLERIES, imageForSkin } from '../components/xiaoyu/widget-state.mjs'
import { Block } from './shared'
export default function VoiceAppearance() {
  const companion = useCompanionContext()
  return <>
    <Block title="声音与朗读" hint="人物的声音设置保留在这里，与对话里的情绪潮汐共用同一套数据，不另外保存一份。">
      <SpeechSettings />
      <a href="#/chat">回到对话设置声音</a>
    </Block>
    <Block title="陪伴形象" hint="与公仔面板共用现有四组立绘。选择只影响本机展示，不改变人格身份或素材内容。">
      <label className="soul-check"><input type="checkbox" checked={!companion.hidden} onChange={e => companion.setHidden(!e.target.checked)} />显示桌面公仔</label>
      <div className="soul-galleries">{GALLERIES.map(g => <button type="button" key={g.id} aria-pressed={companion.skin === g.id} className="soul-gallery" onClick={() => companion.chooseSkin(g.id)}>
        <img src={imageForSkin(g.id)} alt="" loading="lazy" /><strong>{g.label}</strong><span>{g.detail}</span><span>{companion.skin === g.id ? '正在使用' : '选择这组'}</span>
      </button>)}</div>
    </Block>
  </>
}
