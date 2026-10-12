---
name: motionsites-reel
description: 当用户要做 motion reel / 动效作品集网页、AI 建站提示词（Lovable/Bolt/Cursor）、复用 motionsites 语料或做三联屏滚动叙事时使用：531 条语料 + 8 点施工骨架 + 二维检索。
---

# MotionSites 动效建站提示词（motionsites-reel）

一句话：**把 motionsites.ai 的 531 条语料当检索库，用"逐组件施工规格"骨架写 AI 建站提示词——写数值，不写感觉。**

## 语料地图（2026-09-26 抓取）
| 文件 | 用途 |
|---|---|
| `D:\pi-workspace\文档\motionsites提示词库.json` | 531 条全量字段（467KB，程序化检索用这个） |
| `D:\pi-workspace\文档\motionsites提示词库.md` | 531 条 id 索引 + 分类 Top20（人读） |
| `D:\pi-workspace\文档\motionsites-完整提示词正文11条.md` | 11 条免费完整正文（骨架出处） |
| `D:\pi-workspace\文档\motionsites提示词结构-方法提炼.md` | 8 点骨架 + 可直接套用的中文模板 |
| `D:\pi-workspace\交付\motionsites-3d-story预览图.webp` 等 | 视觉参考 |

## 二维检索法
先定「页面类型」轴（Landing Page / Hero / SaaS / Agency / Portfolio / Marquee / Pricing…，Top20 词表见 md 索引），再定「交互特征」轴（玻璃拟态 / 背景视频 / 跑马灯 / 3D / 光标拖尾）。两轴交叉锁定 id，回 json 拿字段。注意分类词以索引原词为准（"Hero Section" ≠ "Hero"）。

## 写提示词的 8 点骨架（11 条正文 100% 命中）
1. **首句锁技术栈且带版本**：`React + Vite + Tailwind CSS v4 + Motion（import { motion } from "motion/react"）+ lucide-react + hls.js`
2. **Dependencies 列全**：含 @tailwindcss/vite、@vitejs/plugin-react
3. **Google Fonts 双字体**：正文 Inter 多 weight + 标题 Instrument Serif（regular+italic）——"高级感"第一来源
4. **Global CSS**：`@theme` 变量、`:root` 的 --background/--foreground、抗锯齿、letter-spacing:-0.01em
5. **自研效果类**：`.liquid-glass`（blur(4px)+inset 高光+渐变描边 mask-composite:xor）做成复用 class，不散 inline
6. **组件编号分节**（1.Navbar / 2.Hero / 3.CTA / 4.Marquee…），每节讲清 props/state 与 DOM 层级
7. **精确文案逐字给出**（"Exact text formatting:"），不让 AI 自由发挥
8. **氛围三件套**：全屏背景视频（hls.js 播 .m3u8，静音循环，object-cover）+ SVG feTurbulence 噪声叠层 opacity 0.03-0.06 + 微交互（打字机/跑马灯/光标拖尾）

完整中文模板：读「方法提炼.md」照抄骨架填空。

## 硬规矩（踩过坑）
- 只写数值规格（blur 值 / mask / weight / opacity），**禁写"高端大气有设计感"**——AI 会回退默认审美
- Tailwind **v4 用 @theme**，v3 用 tailwind.config.js；版本号写错全盘错
- 单屏页明说 no scroll / 100vh
- **付费墙现实**：531 条中 350 条付费，匿名侧公开字段残缺（如 3d-story 只见标题/分类/hero 类型），全量正文只有免费 11 条——别花时间试付费条目，缺的规格用骨架自补

## 验收
- 提示词：8 点各占一节、版本号齐全、文案逐字、氛围三件套齐备
- 生成页面：按交付纪律验（可打开、尺寸、动效真实存在），不靠"看着像"

## 失败处理
- 生成结果平庸 → 九成是第 7 点（精确文案）或第 5 点（效果 class）缺失，补数值重发
- 依赖报错 → 先查 Tailwind 版本与 @theme / tailwind.config.js 是否匹配
- json 检索为空 → 分类词换成 md 索引 Top20 原词再试
