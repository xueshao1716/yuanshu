import AutoPatchCard from '../soul/AutoPatchCard'

/**
 * 小语改了自己（一级页面，2026-10-28 改版）
 *
 * 用户反馈：「这个界面跟上面那个自动补丁都有点工程化，不够工作化，不好上手」
 * 改法：标题先说清楚"这是她改自己的地方"，正文只回答三个问题：
 *   改了什么？影响我什么？我该点哪个？
 */
export default function AutoPatches() {
  return (
    <div className="mx-auto w-full max-w-[900px] px-4 py-8">
      <header className="mb-5">
        <h1 className="text-[20px] font-semibold text-pi-text">小语改了自己</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-pi-dim2">
          她发现问题、自己动手改代码的时候，改动会先放在这里。
          <strong className="text-pi-text">在你说「用上」之前，系统一点都不会变</strong>——所以放心看。
        </p>
      </header>

      <div className="rounded-pi-md border border-pi-border-soft bg-pi-panel p-5">
        <AutoPatchCard />
      </div>

      <p className="mt-4 text-[12px] leading-relaxed text-pi-dim2">
        想了解她为什么改？去 <a className="underline" href="#/soul">灵魂培育</a> 看她最近的判断；
        想知道改完的效果？改完并「用上」之后，会在 <a className="underline" href="#/board">工作台</a> 留一条记录。
      </p>
    </div>
  )
}
