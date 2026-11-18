import { SpeechSettings } from '../components/voice/SpeechSettings'
import { Block } from './shared'
import PortraitSlot from './PortraitSlot'
export default function VoiceAppearance() {
  return <>
    <Block title="声音与朗读" hint="和对话里的声音设置是同一份。">
      <SpeechSettings />
      <a href="#/chat">回到对话设置声音</a>
    </Block>
    <Block title="陪伴形象" hint="选择只影响本机显示。">
      <PortraitSlot />
      <a href="#/soul?s=pet">桌面公仔的开关和立绘在「桌面公仔」页</a>
    </Block>
  </>
}
