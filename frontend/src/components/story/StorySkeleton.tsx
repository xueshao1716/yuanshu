// 首屏骨架（2026-09-16 视觉整理的第 7 条）。
//
// 为什么需要它：项目列表还在路上时，`project` 是 null，页面直接渲染「开始一个故事」——
// 于是先闪一屏"你没有故事/从零开始"，几百毫秒后再跳成工作台。这比"慢"更难受：
// 用户会误以为自己刚才的故事没了。
//
// 做法：用灰块把**真实版式**先占住（状态条 / 左时间线 / 中编辑器 / 右结果），
// 数据到了原地替换，不发生重排。块数与真实布局一致，尺寸也照 `.story-timeline`
// 那一列的 200px 和主区的比例来，不是为了好看随便画的。
export default function StorySkeleton() {
  return (
    <div className="story-skeleton" role="status" aria-live="polite" aria-label="正在加载故事">
      <div className="story-skeleton-bar" aria-hidden="true">
        <span className="story-skeleton-pill" />
        <span className="story-skeleton-pill" />
        <span className="story-skeleton-pill" />
        <span className="story-skeleton-pill" />
        <span className="story-skeleton-line is-wide" />
      </div>
      <div className="story-skeleton-layout" aria-hidden="true">
        <div className="story-skeleton-col is-side">
          <span className="story-skeleton-line is-short" />
          <span className="story-skeleton-line" />
          <span className="story-skeleton-line" />
          <span className="story-skeleton-line" />
          <span className="story-skeleton-line is-short" />
          <span className="story-skeleton-line" />
        </div>
        <div className="story-skeleton-col is-main">
          <span className="story-skeleton-line is-title" />
          <span className="story-skeleton-line" />
          <span className="story-skeleton-block" />
          <span className="story-skeleton-line is-short" />
          <span className="story-skeleton-block" />
        </div>
        <div className="story-skeleton-col is-side">
          <span className="story-skeleton-line is-title" />
          <span className="story-skeleton-block is-thumb" />
          <span className="story-skeleton-line" />
          <span className="story-skeleton-line is-short" />
        </div>
      </div>
    </div>
  )
}
