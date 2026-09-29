import { useCompanionContext } from '../components/xiaoyu/CompanionProvider'
import { GALLERIES } from '../components/xiaoyu/widget-state.mjs'
import { Block } from './shared'
export default function VoiceAppearance() {
  const companion = useCompanionContext()
  return <>
    <Block title="声音与朗读" hint="自动朗读、音色与模型统一在对话右上角「情绪潮汐 → 声音」设置；这里不再重复一套控件。"><a href="#/chat">回到对话设置声音</a></Block>
    <Block title="陪伴形象" hint="立绘组与免打扰统一在公仔面板的「陪伴设置与立绘」里调整，只影响展示，不改变人格身份。">
      <dl className="soul-facts"><div><dt>当前立绘组</dt><dd>{GALLERIES.find(g => g.id === companion.skin)?.label || '待确认'}</dd></div><div><dt>本机显示</dt><dd>{companion.hidden ? '已隐藏' : '已显示'}</dd></div></dl>
      {companion.hidden ? <button onClick={() => companion.setHidden(false)}>显示公仔以打开陪伴设置</button> : <p className="soul-hint">点击公仔，展开「陪伴设置与立绘」。</p>}
    </Block>
  </>
}
