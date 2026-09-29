---
name: 元枢灵魂培养中心
description: 复用工作台主题的受保护配置界面，仅约束 soul 分区
typography:
  heading:
    fontSize: "24px"
    fontWeight: 650
    lineHeight: 1.3
  section:
    fontSize: "17px"
    fontWeight: 650
  body:
    fontSize: "14px"
    lineHeight: 1.65
  hint:
    fontSize: "12px"
spacing:
  action: "10px"
  form: "20px"
  navigation: "36px"
components:
  button:
    height: "44px"
    padding: "9px 14px"
  input:
    height: "44px"
    padding: "10px 12px"
---

# Design System: 元枢灵魂培养中心

## Overview

**Creative North Star: "清楚、安静的培养工作台"**

沿用用户批准的独立培养中心方向：左侧分区、右侧操作，事实和修改流程优先于装饰。此文件记录已实现的局部惯例，不重新定义整个元枢的视觉系统。

**Key Characteristics:**

- 主题继承，避免设置页出现第二套配色。
- 纵向分区，依靠留白和细分隔线组织密度。
- 差异、确认、结果与回退各自明确。

## Colors

沿用全局 `--pi-accent`、`--pi-text`、`--pi-dim`、`--pi-bg`、`--pi-bg1`、`--pi-bg2`、`--pi-border` 和 `--pi-border-soft`。这里不复制亮暗主题的具体颜色值。

**The Single Theme Rule.** 强调色只承担主要操作、选择态和焦点提示；错误或未就绪状态同时使用文字说明，不仅依赖颜色。

## Typography

字体继承元枢全局字体栈。标题、分区、正文和提示分别采用 frontmatter 的层级；手机标题收至 22px。读数使用等宽数字特性，长说明最大 75ch。没有新增展示字体或字体下载。

## Layout

主体最大宽 1180px，桌面左右内边距 32px，导航 208px、工作区自适应；表单两列。900px 以下导航收至 180px、间距 24px，画廊变两列。640px 以下导航改原生选择器、表单单列、左右内边距 16px。表格仅在自身容器滚动。

## Elevation & Depth

本分区没有新增阴影。背景层级、细边框与留白表达分区；确认区域用强调色边框体现操作重要性。

## Shapes

普通控件复用 `--pi-radius-sm`（回退值 8px），确认区域使用 12px 圆角。结构化列表采用平直分隔线，不将每段文字包成卡片。

## Components

- 按钮和输入控件至少 44px 高；禁用态降低透明度并阻止交互，焦点保留可见轮廓。
- 导航在桌面使用左对齐按钮及当前态，手机使用有标签的原生选择器。
- 差异区保留换行并允许长串折行；确认区同时呈现理由、目标及一次性确认状态。
- 声音设置复用 SpeechSettings；四套画廊复用现有 CompanionProvider，不复制一份配置。
- 状态过渡为 150ms 背景变化，减少动态效果偏好下关闭过渡。

## Do's and Don'ts

### Do:

- Do 继承主题与共享控件，保留键盘焦点和至少 44px 触控区域。
- Do 让事实、草稿、待确认与已生效状态明确分开。

### Don't:

- Don't 为视觉完整而编造培养评分、健康状态或不存在的开关。
- Don't 用页面预览成功暗示所有运行会话已经重载人格。

本文件来自源码和已完成的 DOM 检查；未把无法读取的截图当作视觉验收依据。
