import { useCallback, useEffect, useState } from 'react'
import useSWR from 'swr'
import { Smartphone } from 'lucide-react'
import { api } from '../../api'
import SectionHeader from '../SectionHeader'

// 2026-11-20 手机控制：元枢 App 里逐项打开能力（默认全关）；电脑/网页上只看哪些手机在线、开了什么。
type CapState = { cap: string; on: boolean; permitted: boolean }
type NativeState = { caps: CapState[]; accessibility: boolean; notificationAccess: boolean; screenshot: boolean; device: string; android: string; batteryFree?: boolean }
type PhoneBridge = { state: () => string; setCap: (cap: string, on: boolean) => void; openAccessibility: () => void; openNotificationAccess: () => void; openAppSettings: () => void; openAssistantSettings: () => void; openBatterySettings?: () => void }
type Device = { id: string; name: string; model: string; android: string; caps: string[]; lastSeen: number }

const LABEL: Record<string, [string, string]> = {
  apps: ['打开应用/网址', '按名字打开应用、打开链接；看已装应用列表'],
  clipboard: ['剪贴板', '读/写剪贴板（读取需要元枢在前台，系统限制）'],
  notifications: ['读取通知', '看通知栏里的消息摘要（需要系统「通知使用权」）'],
  location: ['位置', '查当前定位'],
  calendar: ['日历', '查日程、新建日程（自动提前 10 分钟提醒）'],
  alarm: ['闹钟/计时', '设闹钟、开计时器'],
  contacts: ['通讯录', '按名字查号码'],
  call: ['打电话', '每次都会在手机上弹确认，你点允许才拨'],
  sms: ['发短信', '每次都会在手机上弹确认，你点允许才发'],
  screen: ['屏幕操作', '读界面、点按、输入、滑动、截图（需要系统无障碍设置里启用元枢）。每个对话第一次操作要你允许，支付/银行类应用不碰'],
}

const bridge = () => (globalThis as { YuanshuPhone?: PhoneBridge }).YuanshuPhone

function readNative(): NativeState | null {
  try { const b = bridge(); return b ? JSON.parse(b.state()) as NativeState : null } catch { return null }
}

export default function PhoneControlPanel() {
  const [native, setNative] = useState<NativeState | null>(readNative)
  const refresh = useCallback(() => setNative(readNative()), [])
  useEffect(() => {
    window.addEventListener('yuanshu-phone-state', refresh)
    window.addEventListener('focus', refresh)
    return () => { window.removeEventListener('yuanshu-phone-state', refresh); window.removeEventListener('focus', refresh) }
  }, [refresh])
  const { data, error } = useSWR<{ devices: Device[]; adb?: { enabled: boolean; devices: string[] } | null }>('phone-status', () => api('/api/phone/status'), { refreshInterval: 5000 })
  const toggle = (cap: string, on: boolean) => { bridge()?.setCap(cap, on); setTimeout(refresh, 300) }

  return (
    <section data-slot="phone-control" className="mb-8">
      <SectionHeader title="手机控制" description="让小语用你的安卓手机办事：开应用、设闹钟、记日程、查通知，或者直接替你点屏幕。每一项默认关，在手机上的元枢 App 里逐项打开。" />
      <div className="panel space-y-4">
        <div className="space-y-2">
          <p className="inline-flex items-center gap-2 text-sm font-medium text-pi-text"><Smartphone size={18} aria-hidden="true" />在线的手机</p>
          {error && <p className="text-sm text-pi-danger">{String(error.message || error)}</p>}
          {data && !data.devices.length && <p className="text-sm text-pi-dim">还没有手机连上。在手机元枢 App 里登录，并在这一页打开至少一项能力；App 退到后台也会保持连接。</p>}
          {data?.devices.map(d => <div key={d.id} className="text-sm text-pi-text">
            {d.name}{d.android ? ` · Android ${d.android}` : ''} — 已开：{d.caps.length ? d.caps.map(c => LABEL[c]?.[0] || c).join('、') : '（还没开任何一项）'}
          </div>)}
          {data?.adb?.enabled && <p className="text-sm text-pi-dim">USB 调试通道已开{data.adb.devices.length ? `：${data.adb.devices.join('、')}` : '（没有检测到设备）'}</p>}
        </div>
        {native ? <div className="space-y-3 border-t border-pi-border-soft pt-4">
          <p className="text-sm font-medium text-pi-text">这台手机（{native.device}）开放给小语的能力</p>
          {native.caps.map(c => <label key={c.cap} className="flex items-start gap-3 text-sm min-h-11">
            <input type="checkbox" className="mt-1" checked={c.on} onChange={e => toggle(c.cap, e.target.checked)} />
            <span className="space-y-1">
              <span className="block text-pi-text">{LABEL[c.cap]?.[0] || c.cap}{c.on && !c.permitted && <span className="text-pi-danger">（系统权限还没给）</span>}</span>
              <span className="block text-pi-dim">{LABEL[c.cap]?.[1]}</span>
            </span>
          </label>)}
          <div className="flex flex-wrap gap-3">
            <button type="button" className="btn-ghost min-h-11 px-3" onClick={() => bridge()?.openAccessibility()}>无障碍设置{native.accessibility ? '（已启用）' : ''}</button>
            <button type="button" className="btn-ghost min-h-11 px-3" onClick={() => bridge()?.openNotificationAccess()}>通知使用权{native.notificationAccess ? '（已开）' : ''}</button>
            <button type="button" className="btn-ghost min-h-11 px-3" onClick={() => bridge()?.openAppSettings()}>应用权限</button>
            <button type="button" className="btn-ghost min-h-11 px-3" onClick={() => bridge()?.openAssistantSettings()}>设为默认助理</button>
            {bridge()?.openBatterySettings && <button type="button" className="btn-ghost min-h-11 px-3" onClick={() => bridge()?.openBatterySettings?.()}>后台保活{native.batteryFree ? '（已关电池优化）' : ''}</button>}
          </div>
          {native.batteryFree === false && <p className="text-sm text-pi-danger leading-relaxed">电池优化还开着：元枢一切到后台（比如替你打开别的应用时），系统可能把它冻住，指令就断了。点「后台保活」关掉；荣耀/华为手机还要到 设置 → 应用 → 应用启动管理 → 元枢，改成手动管理并打开「允许后台活动」。</p>}
          <p className="text-sm text-pi-dim leading-relaxed">设为默认数字助理后，长按电源键或主页键会直接打开元枢语音。屏幕操作时顶部有「元枢正在操作」浮条，点停止立刻收回；打电话、发短信，以及点发送/付款/删除这类按钮前都会在手机上问你。{!native.screenshot && '这台手机低于 Android 11，不支持截图（读界面文字不受影响）。'}</p>
        </div> : <p className="text-sm text-pi-dim border-t border-pi-border-soft pt-4">能力开关在手机上：用元枢安卓 App 打开「授权中心 → 手机控制」。</p>}
      </div>
    </section>
  )
}
