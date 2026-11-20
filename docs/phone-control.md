# 手机控制（2026-11-20，2.223.0）

让元枢像 Grok 那样用你的安卓手机办事。四期一次做完：双向通道 → 系统能力 → 屏幕操作 → 默认助理。

## 结构

```
手机 App（Capacitor 壳 android/）                 服务器（server.mjs）
  PushService 前台服务                             engine/phone/hub.mjs     设备表 + 等待中的指令
    ├─ /api/notify/stream  （原有：收通知）          engine/phone/routes.mjs  /api/phone/stream|status|hello|result
    └─ /api/phone/stream   （新：收指令）  ──cmd──▶  engine/phone/tools.mjs   phone 工具（统一引擎 + Pi 引擎都挂）
         PhoneCommands 执行 → POST /api/phone/result ◀─                 engine/phone/adb.mjs     USB 调试回落（开发用，默认关）
```

- 手机只在「手机控制」里**至少开了一项**时才连指令通道；鉴权沿用登录令牌（主令牌或扫码配对的设备令牌）。
- 每条指令一个 id，服务器等结果，默认 30 秒超时（打电话/发短信 90 秒，截图 45 秒）；手机断线时未完成的指令立刻失败。
- 能力开关存在手机上（SharedPreferences `yuanshu_phone`），手机在连接和开关变化时把「开着且系统权限到位」的能力报给服务器；服务器只做提前拦截，真正的判断在手机上（两边都拦）。

## 能力与安全边界

| 能力 | 动作 | 说明 |
|---|---|---|
| apps | open_url / open_app / list_apps | App 在后台且无障碍没开时，Android 不让后台弹界面，改发一条「点一下打开」的通知 |
| clipboard | clipboard_get / clipboard_set | Android 10+ 读剪贴板要求元枢在前台 |
| notifications | notifications | 需要系统「通知使用权」 |
| location | location | WGS84 坐标 |
| calendar | calendar_list / calendar_add | 写入可写的主日历，自动提前 10 分钟提醒 |
| alarm | alarm_set / timer_set | 系统时钟 Intent |
| contacts | contacts_search | 只按名字查号码 |
| call / sms | call / sms | **每次**在手机上弹确认通知，点允许才执行 |
| screen | screen_read / tap / type / swipe / key / screenshot / stop | 无障碍服务 YuanshuAccess |

屏幕操作额外的边界：
- 每个对话第一次操作要在手机上允许（授权按会话，换对话重新允许）；授权期间屏幕顶部有「元枢正在操作」浮条，点停止即收回。
- 支付/银行/证券/密码管理类应用（`YuanshuAccess.BLOCKED_PKG`）不读、不点、不打开；密码框不读也不填。
- 点「发送/支付/付款/转账/删除/确认购买/下单」类按钮前在手机上确认。
- 截图需要 Android 11+，缩到 1080 宽，存 `生成物/手机截图/`。

## 默认助理（第四期）

App 声明了 `ASSIST` / `VOICE_COMMAND` 入口。在「手机控制」点「设为默认助理」，到系统里把元枢设为数字助理应用后，长按电源/主页键会打开元枢并直接进语音对话（原生派发 `yuanshu-assist` 事件）。

## USB 调试回落

`记忆/运行时/手机控制.json` 写 `{"adb": true}`，手机 App 不在线时 phone 工具用 `adb`（默认找 `C:\Android\Sdk\platform-tools\adb.exe`）操作 USB 连着的手机。只支持 apps/screen 两类；输入只能英文。

## 电脑操作放权（同版）

- 单步确认可以在手机/远程网页批准（`/api/agent/confirm` 不再拦 computer-use；agent-pending 里 computer-use 不再标「仅本机」）。
- scroll 不弹确认；授权时长 10/30/60/120 分钟（默认 30）；可选「免逐步确认」（`trust`），授权期内 click/type 直接执行，仍会重新观察比对窗口。
- 开授权（读窗口、grant、选窗口）仍只能本机页面；查看状态和停止可以远程。

## 验证

- 单测：`tests/unit/phone-hub.test.mjs`、`computer-use.test.mjs`、`computer-wiring.test.mjs`。
- 真机：装新 APK → 登录 → 授权中心 → 手机控制 → 打开「打开应用/网址」→ 电脑上问元枢「用手机打开 B 站」。
