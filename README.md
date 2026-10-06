<p align="center">
  <img src="docs/logo-xiaoyu-hd.png" width="96" alt="小语 AI logo">
</p>

# 元枢 · 个人智能系统（Yuanshu）

<p align="center">
  <b>一个大脑，全端皮肤 —— 有记忆、有情绪、会进化的个人专属 AI 伙伴</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%3E%3D20-339933" alt="Node">
  <img src="https://img.shields.io/badge/React%2019%2BNode.js-多端工作台-4EC9B0" alt="react-node">
  <img src="https://img.shields.io/badge/多模型-10%2B%20通道-7C5CFF" alt="multi-model">
  <img src="https://img.shields.io/badge/图生图-支持-FF9E43" alt="i2i">
  <img src="https://img.shields.io/badge/License-Apache--2.0-3DA639" alt="license">
</p>

> 🧠 **记忆系统** · ❤️ **情绪引擎** · 🧬 **进化系统** · 📦 **智能文件交付** · 📡 **一键外网分享**

元枢以自建对话循环为核心，并兼容成熟的外置 Agent 管线，把终端里的 AI 能力变成完整的全平台工作伙伴：会话、工具调用、媒体生成、工作空间管理，Windows / Linux / Android / Web / 手机页面全端覆盖。

> **品牌层级**：元枢 = 整个系统 · 小语 = 伙伴人格（与你对话的那个她）· 架构详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## 🖼 界面一览

<p align="center">
  <img src="docs/images/demo-main.png" alt="工作台主界面" width="640">
  <br>
  <em>工作台主界面</em>
</p>

<p align="center">
  <img src="docs/images/demo-workspace.png" alt="工作空间全屏" width="640">
  <br>
  <em>工作空间全屏浏览</em>
</p>

## ✨ 核心能力

| 能力 | 说明 |
|---|---|
| 🧩 **双引擎** | **元枢自建引擎**（对话/工具/记忆/出图）+ **dsh 引擎**（DeepSeek Harness：独立执行臂，可派单并行干活） |
| 🧠 **记忆系统** | 固定记忆 + 记忆日志自动沉淀 + 经验库，跨会话长期记得你的偏好，越用越懂你 |
| ❤️ **情绪引擎** | VAD 三维情绪感知，对话自适应语气与节奏（烦躁时先安抚、着急时给快路径） |
| 🧬 **进化系统** | 任务完成自动归纳经验，提案制沉淀，可回滚 |
| 🔌 **多模型通道** | deepseek / OpenAI / 阿里百炼 / Kimi / 智谱 / 火山 / xAI / Mistral / 商汤 / 魔搭 等 10+ 家，首启引导弹窗选一家填 key 即可用 |
| 🖼 **媒体生成** | 配图/配音/视频，多出图通道（minimax/千问万相/火山 seedream/ModelScope/Agnes/Cloudflare FLUX），图生图、批量出图、自动归档 |
| 🎨 **万象人物工坊** | 专业写真工坊：场景/五要素/深度模式（人体分形+光影雕刻+去AI化材质）/色彩方案 |
| 📦 **智能交付** | 要图只给图/要 PPT 只给 PPT，关键词匹配 + 去重 + 断点续传 |
| 🗂 **工作空间** | 工程/文档/生成物/交付分类视图，全屏浏览，文件搜索 |
| 🌳 **会话管理** | 分支、模板、项目分组、导出、置顶 |
| 📡 **一键外网分享** | 项目放分享目录即上线，稳定域名，多项目零配置 |
| ⚡ **SSE 背压控制** | 对标 pi EventStream：慢网络不丢事件不堆内存，公网长回复稳定 |

## 🚀 一条命令安装（Windows）

**最简单方式（自动装 Node + 双引擎 + 源码 + 启动）：**

```powershell
# Gitee（国内快）
irm https://gitee.com/linxinyu520xue/yuanshu/raw/main/install-lite.ps1 | iex

# GitHub
irm https://raw.githubusercontent.com/xueshao1716/yuanshu/main/install-lite.ps1 | iex
```

> 安装中会询问两件事，全部回车即可用默认：① 安装目录（不想装 C 盘可输 `D:\pi-web`）② 元枢兼容适配器/dsh 引擎全局包装哪个盘（输 `D:\npm-global` 可装 D 盘）。
> 装完自动：生成访问令牌 → 启动服务 → 打开浏览器；首次打开弹窗选一家模型商填 API Key 就能开始对话。

**全局安装（npm，适合已装 Node 的用户）：**

```powershell
npm i -g git+https://gitee.com/linxinyu520xue/yuanshu.git
yuanshu
```

**手动方式（跨平台）：**

```bash
git clone https://gitee.com/linxinyu520xue/yuanshu.git   # 或 GitHub
cd pi-web
node setup.mjs --install   # 检测环境并自动装缺失依赖
node server.mjs            # 启动，浏览器开 http://127.0.0.1:8787
```

## 🔑 配置 API 密钥（必做）

模型不可用 = 还没填密钥。三步搞定（以 deepseek 为例）：

1. **获取密钥**：https://platform.deepseek.com → API Keys → 创建，复制 `sk-` 开头密钥
2. **创建 `~/.pi/agent/auth.json`**：

   ```json
   { "deepseek": { "type": "api_key", "key": "sk-你的密钥" } }
   ```

3. **重启服务**，刷新 `http://127.0.0.1:8787` 即可对话

> - 当前默认模型 `zhipu-paid/glm-5.3-flash`，可用环境变量 `YUANSHU_MODEL` 覆盖
> - 更多模型商逐个加进 `auth.json`，模板见 [`models.example.json`](models.example.json)
> - **密钥绝不入库**：`auth.json` 与 `models-store.json` 都在 `~/.pi/agent/`（仓库外）

## 🧩 内置技能（开箱即用）

| 技能 | 用途 |
|---|---|
| `web-search` | 网页搜索（Brave API，可选 key） |
| `image-generation` | 图片生成（配图/画图） |
| `voice-transcribe` | 语音转文字（录音/会议） |
| `session-export-redacted` | 导出会话自动脱敏 |
| `wanxiang-portrait` | AI 人物写真提示词（MJ/SD/即梦/Imagen3 通用） |
| `wanxiang-design` | 平面设计提示词（三维坐标/东方美学/色彩引擎） |
| `novel-forge-v10` | AI 中文网文写作（编辑部 8 角色/灵魂系统/元认知） |

> 🎨 独立技能仓库：[wanxiang-portrait-skill](https://github.com/xueshao1716/wanxiang-portrait-skill)；完整技能清单见 [SKILLS.md](SKILLS.md)

## ⚙️ 环境变量

前缀统一 `YUANSHU_*`（旧 `PI_WEB_*` 仍兼容，新名优先）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `YUANSHU_PORT` | `8787` | 服务端口 |
| `YUANSHU_LAN` | 空 | 设 `1` 监听 `0.0.0.0`，手机局域网直连 |
| `YUANSHU_TOKEN` | 自动生成 | 访问令牌（存 `.token`） |
| `YUANSHU_CWD` | `~/pi-workspace` | 工作空间根目录 |
| `YUANSHU_MODEL` | `zhipu-paid/glm-5.3-flash` | 默认模型 |
| `YUANSHU_SHARE_HOST` | 空 | 外网分享域名（可选） |

完整清单见 README 历史版本与 `server.mjs` 顶部注释。

## 📱 多端

- **Web**：浏览器直接用（服务端同源）
- **Android**：Capacitor/Tauri 双壳打包。APK 文件名必须标明 ABI：单架构用 `arm64`、`armeabi-v7a`、`x86` 或 `x86_64`，四 ABI 合包才叫 `universal`
- **前端构建**：`frontend/` 是唯一前端源码，`frontend/dist/` 是唯一产物源。`npm run deploy:frontend`（build → 清理 → 同步到 `public/` 与 `app/dist/`），旧命令 `npm run build:mobile:web` 是它的别名
- **手机局域网直连**：默认只听 `127.0.0.1`，设 `YUANSHU_LAN=1` 后监听 `0.0.0.0`，配合防火墙与访问令牌

## 👥 交流群

扫码加入元枢微信交流群（「元枢—向上生长」）：

<p align="center">
  <img src="docs/images/group-qr.jpg" alt="元枢交流群" width="280">
</p>

> 微信群二维码 7 天有效，过期请留意仓库更新或联系作者换新。

## 💰 赞赏支持

如果元枢帮到了你，欢迎请小语喝杯奶茶 ☕

<p align="center">
  <img src="docs/images/donate-qr.jpg" alt="赞赏码" width="280">
</p>

## 📄 License

[Apache-2.0](LICENSE) © 2026 xueshao1716

- 允许任何人自由使用、修改、分发（含商业用途），无需付费
- 分发时必须保留原始版权与许可声明（注明原作者）
- **二次开发后分发必须显著注明基于元枢（Yuanshu）修改**
