---
name: 元枢独立语音通话
description: 现有通话 surface 的局部实现记录，不定义全局品牌
colors:
  accent: "var(--pi-accent)"
  on-accent: "var(--pi-on-accent, white)"
  background: "var(--pi-bg1)"
  text: "var(--pi-text)"
  secondary-text: "var(--pi-dim2)"
  surface: "color-mix(in srgb, var(--pi-text) 5%, var(--pi-bg1))"
  line: "color-mix(in srgb, var(--pi-text) 12%, transparent)"
  orb-cyan: "#71dce7"
  hangup: "#bd394b"
  on-hangup: "white"
typography:
  title:
    fontFamily: "var(--pi-font-sans)"
    fontSize: "24px"
    fontWeight: 500
    letterSpacing: "-.025em"
  headline:
    fontFamily: "var(--pi-font-sans)"
    fontSize: "clamp(22px, 3vw, 30px)"
    fontWeight: 450
    lineHeight: 1.35
    letterSpacing: "-.02em"
  body:
    fontFamily: "var(--pi-font-sans)"
    fontSize: "13px"
    lineHeight: 1.65
  label:
    fontFamily: "var(--pi-font-sans)"
    fontSize: "11px"
rounded:
  orb: "50%"
  start: "30px"
  control: "22px"
  view-group: "18px"
  view: "13px"
spacing:
  compact: "4px"
  small: "8px"
  medium: "12px"
  footer: "14px"
  controls: "22px"
components:
  start-button:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.start}"
    padding: "0 26px"
  hangup-button:
    backgroundColor: "{colors.hangup}"
    textColor: "{colors.on-hangup}"
    rounded: "{rounded.control}"
    width: "76px"
  view-button-selected:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.view}"
  orb:
    rounded: "{rounded.orb}"
    width: "clamp(180px, 29vh, 310px)"
    height: "clamp(180px, 29vh, 310px)"
---

# Design System: 元枢独立语音通话（局部）

## Overview

**Creative North Star: "专心说话的流动光球"**

这是对已实现通话画面的局部描述性称呼，不是用户批准的全局品牌命名。采用元枢现有字体、主题和图标，仅在通话中央增加立体渐变光球与双环；没有新增栅格资产，也没有 approved comp 或 QUALITY BAR。

用户确认的方向是独立动态通话画面：默认聚焦光球，转写与任务按需在中部切换。外围操作保持稳定，待确认任务只提示，不强制跳页；画面切换不创建第二条音频连接。

**Key Characteristics:**

- 主题继承，局部青色光球与双环。
- 动态表达真实连接与活动状态，不模拟音量。
- 中部内容切换，底部通话操作保持可达。

范围：`frontend/src/realtime/` 及其通话展示组件。依据 `call.css`、`call-orb.css`、`audio.mjs`、`call.mjs`、`errors.ts`、`../components/{CallScreen,CallStage,RealtimeCall,RealtimeTasks}.tsx`、`../styles.css` 与仓库设计契约 `docs/superpowers/specs/2026-09-28-dedicated-voice-screen-design.md`。记录日期：2026-09-28。本文件是源码提取，不是截图或真机目视验收，不声称复刻 ChatGPT 当前界面。

## Colors

### Primary

- **现有主题强调色**：开始按钮、焦点环、选中静音轮廓与任务计数继承 `--pi-accent`；前景使用 `--pi-on-accent`。
- **流动青色**：仅用于光球流体的一部分；其他渐变色与主题强调色共同构成局部立体感，完整值见 sidecar 片段。
- **挂断红**：局部固定的退出动作色，不覆盖全局错误色。错误状态文字仍用 `--pi-danger`，以 `--pi-red` 兜底。

### Neutral

- **主题底与文字**：页面继承 `--pi-bg1`、`--pi-text` 和 `--pi-dim2`；不固定为晨雾或深色主题。
- **轻表面与分隔线**：按当前文字色混合生成，分别用于控制底、选中视图和低强调轮廓。

**The Theme Inheritance Rule.** 局部文档中的 CSS 变量是运行时绑定，不是新品牌色；切换主题后不得用静态色板替换它们。

## Typography

沿用 `--pi-font-sans`。常见主题的系统字体栈包括 Segoe UI、PingFang SC 与 Microsoft YaHei；书写类主题可覆盖该变量。通话页不加载新字体，也不强制使用现有展示字体或等宽字体。

- 标题、中央短句、说明、控制标签分别对应 frontmatter 的 title、headline、body、label；body 指通话辅助说明，不重定义转写正文。
- 状态和视图标签为紧凑文字（13px）；说明／角色标记常用（12px）；开始按钮（15px）。
- 转写正文保留换行，行高（1.8），长词可断行。计时使用等宽数字，不更换整套字体。

## Layout

采用应用内容区内的纵向流式布局，不是覆盖全局的浮层。进入通话时暂时隐藏应用导航、侧栏、工具栏与陪伴公仔；聊天宿主保留，退出恢复原草稿及滚动位置。

- 顶部标题／返回、状态、可伸缩中部、底部操作；中部允许滚动，头尾不参与压缩。
- 页面内边距为（24px / clamp(16px, 4vw, 64px) / max(14px, safe-area-inset-bottom)）。沿用应用动态视口和安全区。
- 中央说明最大宽度（440px）；准备页说明（460px）；转写／任务阅读区（min(100%, 720px)）。用户转写最大宽度（90%）。
- 窄屏条件（max-width: 600px）：顶部内边距（16px）、标题（21px）、光球（clamp(170px, 27vh, 240px)）。
- 短屏条件（max-height: 640px）后覆盖：光球（130px）、舞台（154px）、控制最小高度（50px），图标与标签横排；开始按钮最小高度（46px）。
- 常规光球舞台比球体宽高各多（50px）。常规控制最小高度（66px），所有 touch-hit 最小点击高度（44px）。

**The Stable Controls Rule.** 通话／转写／任务只替换中部内容，不卸载连接宿主，也不把记录面板叠在通话画面上。

## Elevation & Depth

通话页的深度集中在光球：锥形流动色、径向光照、玻璃暗边、内高光与弥散投影。双环使用主题强调色的低比例混合，不增加栅格贴图或新图形依赖。正文和操作区主要靠轻表面与细边线分层；完整投影值保存在 sidecar。

**The Honest Motion Rule.** 动画是连接／活动指示，不是音量计；不得用随机数或预设脉冲声称麦克风正在采音。

## Shapes

球体与轨道为圆形，轨道做轻度旋转与轴向缩放。控制采用圆角矩形，开始按钮为宽胶囊，视图组为包裹式圆角轮廓；对应半径在 frontmatter 中定义。用户转写仅尾角收紧（20px 20px 6px 20px），助手正文不加同款气泡。

## Components

### 动态光球与状态

- `idle` 降低不透明度；`connecting` 转动外环；`listening` 慢呼吸；`hearing` 加快呼吸；`replying` 加快流体并转动光照及外环；`muted`／`error` 降饱和与不透明度。
- 回复状态由实际播放器回调产生，说话状态由服务事件产生。静音时仍可播放回复，因此回复视觉优先于静音视觉；状态文字提供真实说明。
- 减少动态效果偏好关闭通话区域全部动画与过渡，保留状态文字。具体周期、状态映射和断点见 `.impeccable/design.json`。

### 开始、控制与退出

- 打开准备页不申请麦克风；同意后明确点击开始才申请。麦克风请求与音频 resume 在同一点击栈并发发起，随后准备会话、票据、连接和服务就绪。
- 初始音轨禁用，只有实际 ready 才允许发包并开始计时。连接时保留取消，静音与打断不可用；按钮 disabled 透明度（.42）。
- 挂断后留在结束页；活跃期间返回按钮明确写“结束并返回聊天”。切后台／换聊天／离开页面释放音频，不自动重连。
- 可聚焦按钮、说明入口和记录区使用主题强调色轮廓（2px，外偏移4px）；细指针 hover 才给控制按钮向上位移（2px）。

### 转写、任务与恢复反馈

- 导航使用 `aria-pressed`，记录区有可聚焦的命名 region；状态文字用 polite live region。光球内部装饰不重复播报。
- 转写临时保留，刷新或换聊天清空。任务正文可编辑，执行需单独确认；已确认任务挂断后继续，结果仍回原聊天。保留原聊天草稿，不把任务草稿与聊天草稿混淆。
- 连接阶段分别呈现麦克风、音频、会话、票据、Socket、服务就绪；本阶段等待（8秒）后补充等待与取消提示，不承诺秒连。
- 总启动超时为（45000ms），失败前保存 `failureStage`；各阶段超时、设备错误与音频初始化错误分别解释，未知错误保持中性，不统一归因为网络。

## Do's and Don'ts

### Do:

- **Do** 继承当前主题和字体，仅把光球与双环作为本通话画面的局部特征。
- **Do** 让连接、静音、播放和失败说明对应实际状态，并保留减少动态效果支持。
- **Do** 按需打开转写与任务，保留明确确认、原聊天归属和草稿恢复。

### Don't:

- **Don't** 伪造音量、提前显示已连通，或把授权等待计入通话时长。
- **Don't** 因视图切换重连、因待确认任务强制跳页，或把临时转写宣称为持久聊天记录。
- **Don't** 把局部 North Star 当作全局品牌批准，也不要把源码检查写成目视或真机验收。
