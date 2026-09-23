---
name: 元枢工作台概览
description: 深蓝与薄荷青的安静工作界面，仅约束概览主区域。
colors:
  board-bg: "#0b1625"
  board-panel: "#122234"
  board-line: "#344c5e"
  board-text: "#edf5f7"
  board-muted: "#b1c3ce"
  board-mint: "#b0e7df"
  primary-ink: "#09201f"
  hover-surface: "#213c4c"
  primary-hover: "#c7f0ea"
typography:
  headline:
    fontSize: "clamp(25px, 3vw, 36px)"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-.025em"
  title:
    fontSize: "17px"
    fontWeight: 550
  body:
    fontSize: "14px"
    lineHeight: 1.8
  label:
    fontSize: "12px"
rounded:
  surface: "18px"
  panel: "10px"
  button: "8px"
spacing:
  actions: "10px"
  row: "12px"
  panels: "18px"
  mobile-panels: "20px"
  mobile-sections: "24px"
components:
  button-primary:
    backgroundColor: "{colors.board-mint}"
    textColor: "{colors.primary-ink}"
    rounded: "{rounded.button}"
    padding: "10px 18px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.board-text}"
    rounded: "{rounded.button}"
    padding: "10px 18px"
  focus-panel:
    backgroundColor: "{colors.board-panel}"
    textColor: "{colors.board-text}"
    rounded: "{rounded.panel}"
    padding: "6px 16px 12px"
---

# Design System: 元枢工作台概览

## Overview

已批准的方向是深蓝底色、薄荷青强调与安静的工作界面。本文件描述已实现的概览主区域，不设定新的品牌隐喻，不替代全局主题、聊天界面、改动验收或天团的视觉约定。

依据同目录样式与组件、`../../pages/Board.tsx` 和首页设计说明提取。实现以会话、当前执行和最近交付为首屏内容；工作记录与用量默认折叠。未发现 PRODUCT.md；本记录来自源码，不代表像素级视觉验收。

## Colors

Primary：薄荷青用于主操作、链接、入口图标、运行点与键盘焦点；主按钮配深色文字，悬停使用更浅的薄荷色。

Neutral：深蓝用于区域底色，较浅蓝用于两块状态面板，灰蓝线用于边界，浅色文字与次级灰蓝文字分层。一般入口悬停使用 hover-surface。以上色值由 frontmatter 记录，源头是本目录样式。

## Typography

字体继承全局 `body` 的 `var(--pi-font-sans)`，本区域未指定新字体。默认全局栈为 `-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`，主题可以覆盖，因此不把默认栈固化为局部字体规则。

欢迎标题使用 headline；会话标题使用 title；简介使用 body；辅助标签使用 label。面板标题和操作文字为 14px、字重 550；行标题为 13px、字重 500；行内说明为 12px。会话预览最多两行；行标题单行省略；会话名称允许断行。

## Layout

页面容器最大宽度 1080px。概览主区域内边距 `clamp(18px, 3vw, 32px)`，桌面网格为 `minmax(0, 1.7fr) minmax(220px, 1fr)`：欢迎在左，快捷入口在右，两块状态面板在下一行。区域行列间距分别为 30px、32px；状态面板等宽双列。

视口宽度不超过 640px 时改为单列，视觉和文档顺序均为欢迎、状态面板、快捷入口；状态面板依次为正在执行、最近交付。快捷入口移除左边线和左侧留白，隐藏补充说明；面板横向内边距缩为 12px，面板标题允许换行。

工作台视图切换沿用外围样式：低于 `md` 断点使用原生选择框，桌面使用分段按钮；这与概览内部的 640px 断点不同。

## Elevation & Depth

局部实现使用不透明底色、面板色差与 1px 边线表达层次；没有自定义阴影、背景模糊或玻璃透明度，也未添加局部动画或过渡时长。

## Shapes

外区域、面板、按钮依次采用 surface、panel、button 圆角。状态点为直径 6px 的圆形；运行点使用薄荷青，空闲点使用次级文字色。分隔线与面板边界保持细线。

## Components

- 欢迎与会话：按有效更新时间选择最近会话，缺失或无效时回退创建时间。有会话时主操作为继续会话，新建对话为次操作；无会话时只保留主操作新建对话。新建会清空当前会话选择再进入聊天。读取中、空结果和错误分别显示；更新失败而有缓存时明确提示上次读取的记录。
- 正在执行：合并当前会话运行、实际运行中的定时任务以及 running/active/waiting 子代理记录。历史工作说明不作为运行证据。无关联会话的运行行禁用；子代理行进入天团，定时任务行进入任务页。部分读取失败明确提示，已有记录仍可展示；仅在数据齐全且无记录时显示空闲状态。
- 最近交付：按交付时间降序，最多显示四项。有可打开路径时在新窗口打开文件，无路径时进入资产页。加载、错误与空态分别呈现；缓存伴随错误说明，空态提供去创作入口。
- 快捷入口：创作、任务、天团协作、模型配置四项。入口最小高度 54px，运行及交付行最小高度 66px，主次按钮最小高度 46px，面板文字链接最小高度 44px。
- 交互状态：键盘焦点使用薄荷青 2px 轮廓并向外偏移 4px。只有支持悬停的设备启用 hover；禁用按钮透明度为 .65，使用默认光标。错误提示使用 alert，运行和交付加载提示使用 status。

## Do's and Don'ts

- Do 保留区域内的颜色作用域，并继承用户的全局字体选择。
- Do 区分加载、失败、缓存和真实空结果，保留可用的下一步入口。
- Do 在手机端保持欢迎、状态面板、快捷入口的顺序与可触达尺寸。
- Don't 将这套局部配色推广为聊天或全局主题的强制要求。
- Don't 把历史记录或请求失败呈现为当前执行状态或成功空结果。
- Don't 在本记录中追加未实现的透明材质、字体、动画或品牌隐喻。
