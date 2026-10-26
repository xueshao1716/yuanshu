import AutoPatchCard from '../soul/AutoPatchCard'

/**
 * 自动补丁（一级页面，2026-10-26）
 *
 * 为什么单独开一页：用户明确说"不想敲命令"。补丁的看/合/弃三件事必须点得到，
 * 而不是埋在灵魂培育深处。
 */
export default function AutoPatches() {
  return (
    <div className="mx-auto w-full max-w-[980px] px-4 py-6">
      <header className="mb-4">
        <h1 className="text-[19px] font-semibold text-pi-text">自动补丁</h1>
        <p className="mt-1 text-[12.5px] text-pi-dim2">
          系统自己写出来的改动。它们只待在 <code>auto/</code> 独立分支上——<strong>没合并之前不影响任何东西</strong>。
          看一眼，满意就合并，不满意就丢弃。
        </p>
      </header>
      <div className="rounded-pi-md border border-pi-border-soft bg-pi-panel p-4">
        <AutoPatchCard />
      </div>
    </div>
  )
}
