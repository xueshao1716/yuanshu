---
name: poster-typeset
description: 当用户要给 AI 生成的海报底图叠中文标题/副标题/信息条、做撕纸/活字/套色错位艺术字，或要求"海报文字不能乱码"时使用。AI 只画图不画字，字永远由代码渲染。
---

# AI 海报艺术字排版（poster-typeset）

一句话：**AI 出无字底图，代码叠真字体**。AI 模型画中文必出乱码，所以
文字层永远由本流水线用系统字体（simhei/msyh 等）渲染——分辨率无损、
可精确改字、可复用。

## 资产

- `references/poster_text.py` —— 合成引擎（PIL，无网络依赖）
- `references/spec-example.json` —— 电影海报《第七个夏天》完整示例
- 工作区副本：`D:/pi-workspace/工具/poster_text.py`（日常用这份）
- 模板库：`D:/pi-workspace/工程/_templates/ai-poster-typeset/`

## 流程

1. **出底图**：generate_image 生成海报画面，提示词里明确写
   "无文字、无字母、标题区域留白"（例：下半幅留出大面积纸面/留白区）。
2. **定画布**：底图比目标画布矮没关系——引擎 `extend_paper` 会自动
   向下接纸（中位数取色 + 零均值加性颗粒 + 羽化接缝，见下"三坑"）。
3. **写 spec.json**：元素类型三种——
   - `text`：字号/字距/颜色/anchor（mm 居中）+
     `jitter`（活字抖动 rot/dx/dy）+ `ghost`（套色错位，另一色偏移
     叠印，胶印味的核心）+ `inkbleed`（油墨不匀 0~1）+ `shadow`
   - `rule`：细线（分隔线）
   - `specks`：纸屑/墨点（底部信息区做旧）
4. **跑**：`python 工具/poster_text.py spec.json`
5. **看图验收**（read 成品图），重点查：标题是否溢出、接纸区是否
   有竖纹/灰带/色断层、套色偏移方向是否统一。

## spec 骨架

```json
{
  "base": "无字底图.png", "out": "成品.png",
  "canvas": [1080, 1680],
  "elements": [
    {"type":"text","text":"第七个夏天","font":"simhei","size":148,
     "tracking":10,"color":"#C1121F","xy":[540,1345],"anchor":"mm",
     "inkbleed":0.30,"jitter":{"rot":1.1,"dx":3,"dy":4},
     "shadow":{"color":"#3A2A18","offset":[3,5],"alpha":60,"blur":3},
     "ghost":{"color":"#1B4F9C","offset":[-9,8],"alpha":200,"blur":0.8}}
  ]
}
```

## 三坑（2026-09-19 实战验过的）

1. **标题溢出**：排版宽度必须用 `font.getlength()` 的**步进宽**累计，
   不能用 tile 宽（tile 带旋转 margin，混进去就横向爆炸半屏）。
   引擎已修：`render_char` 返回 adv，排版按 adv 走。
2. **接纸灰带**：接纸色不能填纯色（纸面有横向渐晕），也不能用列
   **均值**（底部残留网点把均值拉暗 → 纵向重复成灰带）。用**中位数**
   取每列色，脏点被排掉。
3. **提亮溢出**：颗粒噪声别用 multiply + 提亮系数（纸面色被顶到 255，
   纸色丢失）。用零均值**加性**颗粒：
   `ImageChops.add(ext, grain_RGB, 1, -128)`（注意 scale/offset 必须
   传 int，PIL 的 chop_add 不收 float）。

## 风格配方速查

- **法式撕纸拼贴**（模板1）：simhei 大标题 + 红 `#C1121F` + ghost 蓝
  `#1B4F9C` 偏移 (-9,8) + msyh 副标题 + 底部 rule 细线 + specks 做旧
- 改风格只动 spec.json，引擎不动。

## 经验库联动

完成一次出片后，若发现新坑（引擎 bug/新配方），回写
`D:/pi-workspace/工程/经验库/experience.md` 并同步本文件"三坑"节。
