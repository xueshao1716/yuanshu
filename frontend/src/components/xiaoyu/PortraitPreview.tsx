import { useState } from 'react'

const portrait = '/assets/portraits/yuanshu-listening-v1.webp'

export function PortraitPreview() {
  const [failed, setFailed] = useState(false)
  return <figure className="xiaoyu-portrait-preview">
    {failed ? <p role="status">形象图片暂时无法加载，请稍后重试。</p>
      : <img src={portrait} alt="元枢 AI 生成的虚构成年女性形象，倾听姿态" onError={() => setFailed(true)} />}
    <figcaption>
      <strong>冷白 · 长发</strong>
      <span>AI 生成形象 · 全覆盖时装预览 · 倾听姿态</span>
      <a href={portrait} target="_blank" rel="noopener noreferrer">打开完整形象</a>
    </figcaption>
  </figure>
}
