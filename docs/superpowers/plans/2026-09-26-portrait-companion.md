# 写真人像陪伴 Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task in this session. Preserve unrelated main-worktree changes.

**Goal:** 制作与用户设定一致的写实素材，作为可选皮肤接入现有公仔。

**Architecture:** widget-state 管理皮肤资源和可游走性；XiaoyuWidget 保留拖动、按皮肤限制游走；独立 PortraitPreview 显示场景原图。素材随 frontend/public 一起构建，不依赖在线图片。

**Tech Stack:** React, TypeScript, node:test, GPT Image CLI, Pillow。

## 执行记录（2026-09-26）

以下清单为原计划，实际交付及偏差以此段和验收记录为准：

- 基线6/6，新增3项先红后绿；加入素材契约后相关测试10/10。
- 原gpt-image-2在当前组不可用，使用已配置的gpt-image-2.5-sunburst。原服装被审核拒绝，改为明确标注的全覆盖时装预览，不声称原设定已实现。
- 请求1024×1536，实得941×1672；同图编辑直接返回RGBA，保留原alpha，不用色键试验结果。优化后的两份WebP已经随前端打包。
- 可选皮肤、固定坐姿、拖动、原图预览与下载已接入，不改默认或旧偏好。
- 隔离全量2200/2200、类型检查、构建和检测均通过；桌面与手机浏览器行为验收通过。
- 图像目检受限：view_image不支持本会话图像输入，面部/手部/发丝和身份一致性尚未视觉验收。因此仅作为可选预览，不冒充最终定稿。
- 本地合入与线上静态资源验证在交付时单独记录；不包含远端推送、原生打包或后端重启。

## 1. 基线与素材

- [ ] `node --test tests/unit/xiaoyu-widget.test.mjs tests/unit/xiaoyu-studio.test.mjs`，预期全部通过。
- [ ] 使用已配置 aieyra 通道的 gpt-image-2，通过 imagegen 自带 CLI 生成 1008x1792 母图。原始提示词见同目录 portrait-source-prompt.txt。
- [ ] 用同一母图编辑为纯绿色底、保持人物坐姿和身份，再用自带 remove_chroma_key.py 提取透明 PNG；验证 alpha、尺寸、查看边缘。
- [x] 优化素材到 `frontend/public/assets/portraits/yuanshu-staircase-v1.webp` 和 `yuanshu-cutout-v1.webp`；记录模型、尺寸与处理过程，不存凭据。

## 2. 测试先行

- [ ] 新增 `tests/unit/portrait-companion.test.mjs`。核心断言：`normalizeSkin('portrait') === 'portrait'`；`imageForSkin('portrait','happy') === imageForSkin('portrait','open')`；`canRoam('portrait') === false`；其他皮肤可游走。
- [ ] `node --test tests/unit/portrait-companion.test.mjs`，确认缺少 portrait 导致失败。

## 3. 接入

- [ ] `widget-state.mjs` 新增 `{ id:'portrait', label:'写真人像', detail:'冷白 · 长发' }` 和对应资源路径；新增 `canRoam = skin => skin !== 'portrait'`，同步 d.mts。
- [ ] XiaoyuWidget 调用 `useWidgetMotion(open || hover || !canRoam(skin))`，坐姿朝向固定为1，真人呼吸但无行走动画。
- [ ] 新建 PortraitPreview.tsx 展示完整原图，提供打开原图，图片失败提供提示。WidgetPanel 根据 skin 使用它或原 WidgetStudio；坐姿禁用游走按钮并解释仍可拖动。
- [ ] 新建 portrait.css，仅按 portrait 属性作用，保留已有尺寸边界与移动端44px点击目标。
- [ ] 重跑新增和原有公仔单测，预期全部通过。

## 4. 验收与交付

- [ ] `npm run verify`，确认 unit/types/build 三项通过；读取测试总数和日志。
- [ ] 运行 Impeccable detect 检查改动组件，对告警逐项确认。
- [ ] 浏览器验证新旧皮肤切换、场景尺寸、拖动、坐姿不游走、移动端面板、原图及图片失败回退。
- [ ] 提交仅本项文件；经确认目标无冲突后合入主工作区，构建线上前端，不覆盖已有粒子面板改动。检查线上资源可用，不宣称已重打包或独立桌宠。
