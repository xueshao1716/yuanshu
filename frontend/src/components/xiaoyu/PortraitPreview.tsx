import { useState } from 'react'

const portrait = '/assets/portraits/yuanshu-staircase-v1.webp'

export function PortraitPreview() {
  const [failed, setFailed] = useState(false)
  return <figure className="xiaoyu-portrait-preview">
    {failed ? <p role="status">形象图片暂时无法加载，请稍后重试。</p>
      : <img src={portrait} alt="AI 生成的成年长发女性形象，黑色服装，坐在冷白光下的黑色楼梯上" onError={() => setFailed(true)} />}
    <figcaption>
      <strong>冷白 · 长发</strong>
      <span>AI 生成形象 · 全覆盖时装预览 · 坐姿陪伴</span>
      <a href={portrait} target="_blank" rel="noopener noreferrer">打开完整形象</a>
    </figcaption>
  </figure>
}
