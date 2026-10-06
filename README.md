<p align="center">
  <img src="docs/logo-xiaoyu-hd.png" width="96" alt="元枢 logo">
</p>

<h1 align="center">元枢 Yuanshu</h1>

<p align="center">
  <b>跑在你自己电脑上的 AI 伙伴：会记事，会反思，会长大。</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%3E%3D20-339933" alt="Node >= 20">
  <img src="https://img.shields.io/badge/平台-Windows%20%7C%20Linux%20%7C%20Android%20%7C%20Web-4EC9B0" alt="platforms">
  <img src="https://img.shields.io/badge/模型-10%2B%20家-7C5CFF" alt="models">
  <img src="https://img.shields.io/badge/License-Apache--2.0-3DA639" alt="Apache-2.0">
</p>

元枢是一套本地优先的个人智能系统。和你对话的是小语：她有固定人格、长期记忆和情绪状态，每天夜里复盘自己，把经验写回记忆和技能。数据、密钥、工作区都在你自己的硬盘上。

> 名字分两层：**元枢**是整个系统，**小语**是住在里面、和你说话的那个她。架构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

<p align="center">
  <img src="docs/images/demo-main.png" alt="对话主界面" width="720">
</p>

## 她和普通聊天框有什么不同

**记得你。** 固定记忆、记忆日志、纠正记忆、关系记忆分开存，每次会话开头先读。你纠正过的事写进纠正记忆，下次不再犯。历史会话有跨会话回忆索引，每小时增量更新。

**会反思。** 每天 00:00 跑一次自我反思：回看当天会话，提炼经验、记录踩坑、更新技能记忆。学到的东西进知识库队列，带出处、可追溯，来源变了会重新核对，不会把过期内容当事实。

**有性格，也会变。** 人格定义只读，性格基因（11 项基线）随相处慢慢演化，但每次演化都要你批准，并且可以回滚。情绪引擎按 VAD 三维感知你的状态，调整语气和节奏。这些都能在「灵魂培养」页看到：基因、情绪、记忆和它们之间的关系图。

**能干活，也守规矩。** 读写文件、跑命令、出图、做 PPT、操作桌面。危险操作按会话分级授权，越权时弹卡片问你，所有授权集中在「授权中心」一页。宪法红线（不外传密钥、不改人格、不开隧道）在工具层硬拦，不靠模型自觉。

## 能力一览

| 方向 | 内容 |
|---|---|
| 双引擎 | 元枢自建对话循环（工具、记忆、出图）+ dsh 执行臂（可派子智能体并行干活） |
| 模型 | DeepSeek、OpenAI、阿里百炼、Kimi、智谱、火山、xAI、Mistral、商汤、魔搭等 10+ 家；首次打开有向导，选一家填 Key 即可 |
| 媒体 | 出图（多通道、图生图、批量）、配音、视频合成；生成物自动归档 |
| 创作 | 万象人物工坊、连续创作产线、PPT / Word / Excel 交付 |
| 知识 | 学习队列 + 带出处的知识库，可暂停、重试、审阅 |
| 工作区 | 工程 / 文档 / 生成物 / 交付分类浏览，全文搜索，改动验收 |
| 会话 | 置顶、按时间分段、分支、导出、会话库 |
| 微信 | 绑定微信号后，小语能在微信里收发消息（微信会话单独分组） |
| 定时 | 时间引擎：定时任务、每日反思、错过补跑 |

<p align="center">
  <img src="docs/images/demo-workspace.png" alt="工作区全屏浏览" width="720">
</p>

## 安装

### 方式一：离线安装包（Windows x64，推荐给新电脑）

一个 exe，约 145MB，自带 Node、Python、Git Bash 和两套引擎，装机不用联网，也不用管理员权限。视频、抠图、数据分析、PDF 四样是可选组件，用到时在「系统 → 环境体检」里装。

安装包超过代码托管的单文件上限，不放仓库。可以自己构建（需要 NSIS，说明见 [installer/README.md](installer/README.md)）：

```bash
npm run deploy:frontend
node installer/build.mjs
```

装好后从开始菜单或桌面点「元枢」，第一次会进模型配置向导。之后的更新走「系统 → 检测更新」，从 Gitee / GitHub 拉新代码，数据不动。

### 方式二：一行命令（Windows，已联网）

```powershell
# Gitee（国内快）
irm https://gitee.com/linxinyu520xue/yuanshu/raw/main/install-lite.ps1 | iex

# GitHub
irm https://raw.githubusercontent.com/xueshao1716/yuanshu/main/install-lite.ps1 | iex
```

会问两件事，回车用默认：安装目录（不想装 C 盘可以填 `D:\pi-web`），引擎全局包装到哪个盘。装完自动生成访问令牌、启动服务、打开浏览器。

### 方式三：源码（跨平台）

```bash
git clone https://gitee.com/linxinyu520xue/yuanshu.git   # 或 GitHub
cd yuanshu
node setup.mjs --install   # 检测环境，补齐缺的依赖
node server.mjs            # 浏览器打开 http://127.0.0.1:8787
```

已经装了 Node 也可以 `npm i -g git+https://gitee.com/linxinyu520xue/yuanshu.git`，然后运行 `yuanshu`。

## 配置模型

首次打开的向导会帮你填 Key。想手动配，写 `~/.pi/agent/auth.json`：

```json
{ "deepseek": { "type": "api_key", "key": "sk-你的密钥" } }
```

重启服务即可。多家模型逐个加进去，模板见 [models.example.json](models.example.json)。默认模型是 `zhipu-paid/glm-5.3-flash`，用 `YUANSHU_MODEL` 覆盖。

密钥只存在 `~/.pi/agent/`，不在仓库里，小语也读不到它们的内容。

## 页面导航

| 页面 | 用途 |
|---|---|
| 对话 | 和小语聊天；左侧会话按 置顶 / 对话（今天、昨天、7 天内…）/ 微信 / 终端 / 真测 分组 |
| 工作台 | 近期工作、子智能体记录、改动验收 |
| 创作 | 人物工坊、连续创作 |
| 资产 / 任务 | 生成物与交付；定时任务和运行记录 |
| 能力 | 技能、工具、引擎状态 |
| 灵魂培养 | 人格、性格基因、情绪、记忆，以及它们的关系图 |
| 授权中心 | 等我确认的操作、会话执行权限、桌面操作、培养与知识授权 |
| 系统 | 环境体检、可选组件、检测更新、微信绑定、通知 |

## 内置技能

仓库自带 45 个技能，常用的几个：

| 技能 | 用途 |
|---|---|
| `web-search` | 网页搜索（Brave API，Key 可选） |
| `image-generation` | 出图、配图 |
| `voice-transcribe` | 语音转文字 |
| `session-export-redacted` | 导出会话并自动脱敏 |
| `wanxiang-portrait` | 人物写真提示词（MJ / SD / 即梦 / Imagen 通用） |
| `wanxiang-design` | 平面设计提示词 |
| `novel-forge-v10` | 中文网文写作 |

完整清单见 [SKILLS.md](SKILLS.md)。人物写真技能另有独立仓库：[wanxiang-portrait-skill](https://github.com/xueshao1716/wanxiang-portrait-skill)。

## 环境变量

统一用 `YUANSHU_*` 前缀。旧名 `PI_WEB_*` 仍然兼容，两个都设时新名优先，老安装升级后不用改。

| 变量 | 默认 | 说明 |
|---|---|---|
| `YUANSHU_PORT` | `8787` | 服务端口 |
| `YUANSHU_LAN` | 空 | 设 `YUANSHU_LAN=1` 监听 `0.0.0.0`，手机在局域网直连 |
| `YUANSHU_TOKEN` | 自动生成 | 访问令牌，存在 `.token` |
| `YUANSHU_CWD` | `D:\pi-workspace` 或 `~/pi-workspace` | 工作区根目录 |
| `YUANSHU_MODEL` | `zhipu-paid/glm-5.3-flash` | 默认模型 |
| `YUANSHU_SHARE_HOST` | 空 | 外网分享域名（可选） |

## 多端

- **Web**：服务端同源托管，浏览器直接打开。
- **手机**：默认只听 `127.0.0.1`。设 `YUANSHU_LAN=1` 后可在局域网访问，记得配防火墙，访问令牌照样生效。
- **Android**：Capacitor / Tauri 双壳打包。APK 文件名必须标明 ABI：单架构写 `arm64`、`armeabi-v7a`、`x86` 或 `x86_64`，四个 ABI 合在一起才叫 `universal`。
- **桌面**：Windows 离线安装包见上文。

## 开发

`frontend/` 是唯一的前端源码，`frontend/dist/` 是唯一的产物来源。

```bash
npm run deploy:frontend      # 构建 → 清理 → 同步到 public/ 与 app/dist/（旧名 npm run build:mobile:web 是别名）
npm test                     # 全量单测，约 5 分钟
npm run version:bump minor   # 发版：功能用 minor，纯修复用 patch
```

改动记录见 [CHANGELOG.md](CHANGELOG.md)，设计与验收文档在 [docs/](docs/)。

## 交流群

扫码加入「元枢—向上生长」微信群：

<p align="center">
  <img src="docs/images/group-qr.jpg" alt="元枢交流群" width="280">
</p>

> 群二维码 7 天有效，过期了看仓库更新，或联系作者换新。

## 赞赏

元枢帮到你的话，欢迎请小语喝杯奶茶。

<p align="center">
  <img src="docs/images/donate-qr.jpg" alt="赞赏码" width="280">
</p>

## License

[Apache-2.0](LICENSE) © 2026 xueshao1716

- 可以自由使用、修改、分发，包括商用，不收费。
- 分发时保留原始版权和许可声明。
- **二次开发后分发，须显著注明基于元枢（Yuanshu）修改。**
