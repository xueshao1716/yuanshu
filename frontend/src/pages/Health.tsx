// 运行健康（2026-11-10）
// 这个页面只干一件事：把过去两天做进后台的观测能力摊开给你看——
//   机制还在不在产出 / 五维退化到哪了 / 定时任务怎么分的类 / 改自己前有没有自证 / 有没有绕闸。
// 全是 GET、全是只读：这里没有任何开关。要动手（解闸、批准、执行动作）走原来的页面，
// 因为"看见"和"决定"必须分开——把按钮放进诊断页，迟早会有人手滑。
import PageHeader from '../components/PageHeader'
import SectionHeader from '../components/SectionHeader'
import HealthVitalityPanel from '../components/panels/HealthVitalityPanel'
import HealthDegradationPanel from '../components/panels/HealthDegradationPanel'
import HealthAssemblyPanel from '../components/panels/HealthAssemblyPanel'
import HealthAntiPatternPanel from '../components/panels/HealthAntiPatternPanel'
import { HealthAdmissionsPanel, HealthBypassesPanel } from '../components/panels/HealthIntegrityPanel'

export default function Health() {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto page-enter">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-8">
        <PageHeader
          title="运行健康"
          description="她自己的机制是否还在产出、退化到什么程度、定时任务怎么分派、改自己之前有没有过闸。"
          meta={<span className="text-[11px] text-pi-dim2">只读观测：本页没有任何开关，数据按需现算</span>}
          actions={<>
            <a className="btn-ghost min-h-11 inline-flex items-center px-3" href="#/soul?s=growth">成长与自省</a>
            <a className="btn-ghost min-h-11 inline-flex items-center px-3" href="#/system">系统</a>
          </>}
        />

        <section>
          <SectionHeader
            title="机制新鲜度"
            description="每一项后台机制最近一次产出是什么时候。新鲜＝最近有产出；停更＝超过它自己的节律；从未产出＝接上了但一次都没跑；无证据＝连判断的凭据都没有。"
          />
          <div className="panel !p-4"><HealthVitalityPanel /></div>
        </section>

        <section>
          <SectionHeader
            title="退化自评"
            description="五个维度各一个 0–1 的分，越高越差；总分决定要不要挂闸。缺数据的维度不计分，也不当成健康。"
          />
          <div className="panel !p-4"><HealthDegradationPanel /></div>
        </section>

        <section>
          <SectionHeader
            title="定时任务审计"
            description="后台按点自己干活的事分两类：固定产出走脚本，要判断的才调模型。两类在同一份快照里对齐，越界能当场看出来。"
          />
          <div className="panel !p-4"><HealthAssemblyPanel /></div>
        </section>

        <section>
          <SectionHeader
            title="自证与准入"
            description="她改自己的代码之前，先跑语法/导入/测试/依赖四步自证；过了才允许进。未通过会说明是哪一步没过。"
          />
          <div className="panel !p-4"><HealthAdmissionsPanel /></div>
        </section>

        <section>
          <SectionHeader
            title="旁路留痕"
            description="哪些入口绕过了上面的自证闸。这里只记录发生过什么，不评价；记录越少，说明闸越严。"
          />
          <div className="panel !p-4"><HealthBypassesPanel /></div>
        </section>

        <section>
          <SectionHeader
            title="反模式台账"
            description="她踩过的坑：怎么认、怎么改。退化自评里的「可信」维度直接来自这里的命中记录。"
          />
          <div className="panel !p-4"><HealthAntiPatternPanel /></div>
        </section>
      </div>
    </div>
  )
}
