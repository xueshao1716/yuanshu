---
name: gpt-image-2
description: GPT-Image-2 精选提示词库（929+ 案例 7 类）：海报/UI与mockup/电商主图/广告创意/角色设计/效果对比。当用户要这几类图的提示词时使用；人像写真默认走 wanxiang-portrait。
---

# GPT-Image-2 提示词库 + 图像生成联动

面向 GPT-Image-2 的**可复用提示词精选库**（929+ 案例，每条含真实成品图 + 完整提示词）。本技能是**索引/路由**：提供库地址、分类、API、生成方式，并与**万像（人像基座）**和 **pi-web 图像生成** 打通联动。

## 提示词库位置（clone 到本地）

- 仓库根：`D:/pi-workspace/工程/awesome-gpt-image-2-prompts/`
- 分类案例文件（**中文**，含成品图引用；**都在上面那个外部仓库里，不在本技能目录**）：
  - 人像/摄影：`D:/pi-workspace/工程/awesome-gpt-image-2-prompts/cases/portrait_zh-CN.md`
  - 海报/插画：`D:/pi-workspace/工程/awesome-gpt-image-2-prompts/cases/poster_zh-CN.md`
  - UI/社媒 mockup：`D:/pi-workspace/工程/awesome-gpt-image-2-prompts/cases/ui_zh-CN.md`
  - 电商主图/场景：`D:/pi-workspace/工程/awesome-gpt-image-2-prompts/cases/ecommerce_zh-CN.md`
  - 广告创意：`D:/pi-workspace/工程/awesome-gpt-image-2-prompts/cases/ad-creative_zh-CN.md`
  - 角色设计/角色卡：`D:/pi-workspace/工程/awesome-gpt-image-2-prompts/cases/character_zh-CN.md`
  - 对比/社区实验：`D:/pi-workspace/工程/awesome-gpt-image-2-prompts/cases/comparison_zh-CN.md`
- 每条案例的成品图：`D:/pi-workspace/工程/awesome-gpt-image-2-prompts/images/<category>_case<NNN>/output.jpg`
- **文件不存在怎么办**：上面那个目录没 clone 到本地时，本库就只是"分类导航"，按分类 + 下面的改写要点直接写提示词，不要去 read 不存在的文件。

> 选提示词时用 read 读对应分类案例文件，按需求挑案例、复制/改写提示词。案例文件较大，按需分段读。

## 🎯 路由规则（联动核心 —— 人像走万像，别绕过）

| 用户要什么 | 走哪套 | 说明 |
|---|---|---|
| **人像/人物/写真/证件照/商务照** | **wanxiang-portrait（万像）** | **红线：人像默认万像基座**，本库人像案例只作**点缀叠加**，禁止喧宾夺主 |
| 海报/插画/UI/电商/广告/角色/对比 | **本库 gpt-image-2 提示词** | 取提示词 → pi-web 图像生成 |

- **人像场景**：先百分百按 `wanxiang-portrait` 生成；如需风格点缀，可从本库 portrait 案例挑**风格词**叠加，但主体/结构/参数以万像为准。
- **非人像场景**：从本库对应分类读 1-3 条案例，提炼/改写成用户需求，再生成。

## 🔌 生成方式（pi-web 图像生成接口）

图像模型走 pi-web `generateImage`（OpenAI 兼容 `/v1/images/generations`，`engine/media-api.mjs`）。已接入图像模型：

- **Agnes**：`agnes-image-2.1-flash`（快，推荐）
- **阿里云百炼**：`wan2.7-image`（高质）
- **MiniMax-M3**：图文混合

> ⚠️ 51relay 的 `gpt-image-1/1.5/2` **当前 upstream forbidden / 接口未通**（实测报错），**暂不能生成**；本库提示词可先用 Agnes/百炼 生成（效果差异大，文字渲染强的走百炼）。待 OpenAI 官方 gpt-image 或 relay 修复后可切。

## 生成流程

1. 明确需求：类别 + 主体 + 风格 + 比例（16:9 / 9:16 / 1:1）
2. 按路由规则选技能（人像→万像；其他→本库）
3. 从本库对应分类读案例 → **复制/改写提示词**（保留关键视觉/风格/光照词，替换主体）
4. 调用图像模型生成（在对话直接描述，系统自动走 `generateImage`）
5. 产物存 `生成物/图片/日期/`，会话界面展示

## 提示词改写要点

- 盯住 GPT-Image-2 强项：**高保真文字渲染**（标题/文案写入图内）、一致角色、布局/分镜、扩图/编辑、比例+透明背景
- 参考案例里的 `{argument name="..." default="..."}` 模板参数：把占位符替换成实际值（场景时长、比例、产品名等）
- 明确负面要求：不要杂乱背景 / 不要品牌 logo / 不要多余肢体（写成"想要的反面"更稳）
- 海报/电商类：要求画面内**干净中文标题**时，提示词要显式给文案内容 + 版式说明

## 红线提醒

- **人像/人物出图默认万像**（用户 2026-08-18 定）：本库人像案例仅点缀，禁止绕过万像即兴发挥
- 本库是**参考库**，不是替代；非人像场景用本库提示词时也要结合用户意图、别硬套模板
