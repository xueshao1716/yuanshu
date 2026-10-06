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
  <img src="https://img.shields.io/badge/开源-MIT-FF6B6B" alt="license">
</p>

> 🧠 **记忆系统** · ❤️ **情绪引擎** · 🧬 **进化系统** · 📦 **智能文件交付** · 📡 **一键外网分享**

元枢以自建对话循环为核心，并兼容成熟的外置 Agent 管线，把终端里的 AI 能力变成完整的全平台工作伙伴：会话、工具调用、媒体生成、工作空间管理，Windows / Linux / Android / Web / 手机页面全端覆盖。

> **品牌层级**：元枢 = 整个系统 · 小语 = 伙伴人格（与你对话的那个她）· 架构详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## 🎯 装完你能得到

**一条命令装完，立刻拥有：**

| 层 | 内容 |
|---|---|
| 🧩 **双引擎** | **元枢自建引擎**（对话/工具/记忆/出图）+ **dsh 引擎**（DeepSeek Harness：独立执行臂，可派单并行干活），外置兼容适配器可按需启用 |
| 🧠 **记忆系统** | 固定记忆 + 记忆日志自动沉淀 + 经验库，跨会话长期记得你的偏好，越用越懂你 |
| ❤️ **情绪引擎** | VAD 三维情绪感知，对话自适应语气与节奏 |
| 🧬 **进化系统** | 任务完成自动归纳经验，提案制沉淀，可回滚 |
| 🔌 **多模型通道** | deepseek / OpenAI / 阿里百炼 / Kimi / 智谱 / 火山 / xAI / Mistral / 商汤 / 魔搭 等 10+ 家，首启引导弹窗选一家填 key 即可用 |
| 🖼 **媒体生成** | 配图/配音/视频，多出图通道（minimax/千问万相/火山 seedream/ModelScope/Agnes/Cloudflare FLUX.2），图生图、批量出图 |
| 📦 **智能交付** | 要图只给图/要 PPT 只给 PPT，关键词匹配 + 去重 + 断点续传 |
| 📡 **一键外网分享** | 项目放分享目录即上线，稳定域名，多项目零配置 |
| 🗂 **工作空间** | 工程/文档/生成物/交付分类视图，全屏浏览，文件搜索 |

## 🚀 一条命令安装（Windows）

**最简单方式（一条命令，自动装 Node + 双引擎 + 源码 + 启动）：**

```powershell
# Gitee（国内快）
irm https://gitee.com/linxinyu520xue/yuanshu/raw/main/install-lite.ps1 | iex

# GitHub
irm https://raw.githubusercontent.com/xueshao1716/yuanshu/main/install-lite.ps1 | iex
```

> `install-lite.ps1` 是纯 ASCII 的引导器：它先把 `install-all.ps1` 下载成文件再执行，
> 因此不受 BOM 与 `param()` 的管道解析问题影响。直接用 `install-all.ps1 | iex` 也能装，
> 但在 PowerShell 5.1 下会多打一行无害的 BOM 报错——想要干净输出就用上面这条。

> 安装中会询问两件事，全部回车即可用默认：① 安装目录（不想装 C 盘可输 `D:\pi-web`）② 元枢兼容适配器/dsh 引擎全局包装哪个盘（输 `D:\npm-global` 可装 D 盘）。
> 装完自动：生成访问令牌 → 启动服务 → 打开浏览器；首次打开弹窗选一家模型商填 API Key 就能开始对话。

> **需要指定安装目录？**（免交互，跳过询问直接装）
> ```powershell
> irm https://gitee.com/linxinyu520xue/yuanshu/raw/main/install-lite.ps1 -OutFile $env:TEMP\piw.ps1
> & $env:TEMP\piw.ps1 -InstallDir D:\pi-web
> ```
> 注意：`install-lite.ps1` 会把 `-InstallDir` 透传给 `install-all.ps1`，所以指定目录时
> 用这条；只想交互式安装则直接用上面的 `| iex` 一行即可。

**全局安装（npm，适合已装 Node 的用户）：**

```powershell
npm i -g git+https://gitee.com/linxinyu520xue/yuanshu.git
yuanshu
```

首次运行 `yuanshu` 自动完成：安装 **元枢兼容适配器 + dsh** → 生成令牌 → 模型清单 → 启动服务并打开浏览器。旧命令 `pi-web` 仍可用。

### 🔑 最后一步：配置 API 密钥（必做）

装完打开界面若模型不可用，是因为还没填密钥。三步搞定：

1. **获取密钥**：打开 https://platform.deepseek.com → API Keys → 创建，复制 `sk-` 开头密钥
2. **创建 `~/.pi/agent/auth.json`**（记事本新建），内容：

   ```json
   { "deepseek": { "type": "api_key", "key": "sk-你的密钥" } }
   ```

3. **重启服务**：`taskkill /F /IM node.exe` 后重新 `yuanshu`（或 `cd ~/pi-web && node server.mjs`），刷新 http://127.0.0.1:8787 即可对话

> 当前默认模型为 `zhipu-paid/glm-5.3-flash`（可用 `YUANSHU_MODEL` 覆盖）；具体可用模型取决于本机 `models-store.json` 和 provider 配置。
> 更多模型商（小米/阿里/火山等）逐个加进 auth.json 即可，模型清单见 `~/.pi/agent/models-store.json`。
>
> **dsh 引擎的 key**：凭证只留在本机进程环境或 `~/.pi/agent/auth.json`，元枢不会替用户登录外部平台，也不会自动执行 `git push`。与元枢共用同一把 DeepSeek key 即可。

## ✨ 为什么与众不同

| 能力 | 说明 |
|---|---|
| 🧠 **记忆系统** | 固定记忆 + 记忆日志自动沉淀 + 经验库，跨会话长期记得你的偏好 |
| ❤️ **情绪引擎** | VAD 三维情绪感知，对话自适应语气与节奏（烦躁时先安抚、着急时给快路径） |
| 🧬 **进化系统** | 任务完成自动归纳经验，越用越懂你的习惯 |
| 📦 **智能文件交付** | 要图只给图/要PPT只给PPT，关键词匹配 + 去重 + 断点续传 |
| 📡 **一键外网分享** | 项目放分享目录即上线，稳定域名，多项目零配置 |
| 🔍 **文件搜索工具** | search_files 按关键词/类型精准定位工作空间文件 |
| 🎨 **工作空间分类视图** | 工程/文档/生成物/交付分类 + 全屏浏览 + 树状连接线 |
| 🖼 **媒体生成** | 配图/配音/视频自动归档，钉钉式文件卡片展示 |
| 🌳 **会话管理** | 分支、模板、项目分组、导出、置顶 |
| 🎨 **万象人物工坊** | 专业写真工坊：场景/五要素/深度模式（人体分形+光影雕刻+去AI化材质）/色彩方案（三色法/极致/东方色） |
| 🖼 **图生图** | 上传真实照片拉入场景/图片修改，自动翻译英文提升控制力，落盘本地签名URL稳定展示 |
| 🖨 **批量出图** | 一次多张并行生成，网格展示点击选图，保存到本地，自动存档工作空间 |
| 🔌 **多出图通道** | minimax / 千问万相 / 火山 seedream / ModelScope / Agnes / Cloudflare FLUX.2 全家桶 |
| ⚡ **SSE 背压控制** | 对标 pi EventStream：慢网络不丢事件不堆内存，公网长回复稳定 |

> 📸 截图（真实界面）：

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

## 🚀 新机器安装

一条命令装完（见顶部「一条命令安装」段落）。

需要手动控制安装步骤（装完 Node 后自己跑）时，可分别执行：

```bash
# Gitee（国内快）
git clone https://gitee.com/linxinyu520xue/yuanshu.git
# 或 GitHub
git clone https://github.com/xueshao1716/yuanshu.git
cd pi-web
node setup.mjs --install
```

装完后：
1. 浏览器打开 `http://127.0.0.1:8787`
2. 输入访问令牌（查看 `C:\Users\你的用户名\pi-web\.token`）
3. 配置 API 密钥（编辑 `~/.pi/agent/auth.json`，如 deepseek）

> 国内网络自动切换 ghproxy 镜像下载，无需手动处理。

## 🧩 内置技能（开箱即用）

| 技能 | 用途 |
|---|---|
| `web-search` | 网页搜索（Brave API，可选 key） |
| `image-generation` | 图片生成（配图/画图） |
| `voice-transcribe` | 语音转文字（录音/会议） |
| `session-export-redacted` | 导出会话自动脱敏 |
| `wanxiang-portrait` | AI 人物写真提示词（MJ/SD/即梦/Imagen3 通用） |
| `wanxiang-design` | 平面设计提示词（三维坐标/东方美学/色彩引擎） |
| `novel-forge-v10` | AI 中文网文写作（产品化/5层共进化/编辑部8角色/灵魂系统/元认知） |

技能面板（左侧 ⚡）直接可用，无需额外安装。

> 🎨 **独立技能仓库**：[wanxiang-portrait-skill](https://github.com/xueshao1716/wanxiang-portrait-skill) —— AI 人物写真提示词生成技能（含 37 章完整系统文档），可单独 clone 到任意技能目录使用。

> 📋 完整技能清单（含 78 个用户技能）见 [SKILLS.md](SKILLS.md)

## 🤖 支持模型

| Provider | 模型 | 说明 |
|---|---|---|
| 智谱 | `glm-5.3-flash` | 当前默认（provider 为 `zhipu-paid`） |
| deepseek | `deepseek-v4-flash` / `deepseek-v4-pro` | 可选，推理强 |
| 小米 mimo | `mimo-v2.5` / `mimo-v2.5-pro` / `mimo-v2-pro` | 中文好，v2.5 支持图片 |
| Agnes | `agnes-2.5-pro` / `agnes-2.5-flash` 等 | 多用途 |
| 阿里云百炼 | `wan2.7-image` 等 | 图像生成 |
| **ModelScope** | `Tongyi-MAI/Z-Image-Turbo` | **免费**每天 2000 次文生图 |
| **Cloudflare** | `FLUX.2 Dev/Klein` / `Leonardo` 等 | **免费**每天 10k Neurons，FLUX.2 高质量 |
| **NVIDIA** | `DiffusionGemma 26B` | 免费聊天+图文 |
| openrouter | 全模型（Claude/GPT/Gemini/Kimi 等） | 需 openrouter key |
| openai | `gpt-4.1` / `gpt-5` 系列 | 需 openai key |
| 火山方舟 | `volces-ark` 系列 | 需 ark key |

> 完整模型清单见 `models.example.json`，复制到 `~/.pi/agent/models-store.json` 即可。

## 特性

- 💬 多模型对话（deepseek / 小米 mimo 等）+ 思考 + 工具调用
- 🛠 编程工具：读文件 / 写文件 / 编辑 / 跑命令
- 🖼 媒体生成：配图、配音（自动归档到工作空间）
- 📡 外网分享：项目放入分享目录，一键生成公网链接
- 📦 工作空间：工程 / 生成物 / 文档 / 交付 四区管理，一键交付
- 📄 文档：Markdown / PDF / Office 解析
- 🌳 会话：分支、模板、项目分组、导出
- 🎨 主题编辑器、可视化页面设计器、技能面板

## 环境要求

- Node.js ≥ 20
- 元枢兼容适配器全局安装：`npm i -g @earendil-works/pi-coding-agent`

## 快速开始

```bash
# 方式零：Windows 一键安装（推荐给小白用户，自动装 Node + 下载 + 启动）
powershell -ExecutionPolicy Bypass -File install-all.ps1

# 方式一：一键安装向导（推荐，跨平台）
node setup.mjs            # 检测环境并引导
node setup.mjs --install  # 自动安装缺失依赖
node setup.mjs --start    # 启动服务

# 方式二：手动
# 1. 安装元枢兼容适配器依赖
npm i -g @earendil-works/pi-coding-agent
# 2. 配置 API 密钥
#    编辑 ~/.pi/agent/auth.json（见下文“配置模型与密钥”）
# 3. 启动
node server.mjs
# 或 Windows：start.bat

# 3. 访问
# http://127.0.0.1:8787
# 首次打开输入访问令牌（见 .token 文件或环境变量 YUANSHU_TOKEN）
```

## 环境变量

变量前缀统一为 `YUANSHU_*`。旧的 `PI_WEB_*` **仍然生效**（两个都读，新名优先），
老安装里已经导出的变量不需要改；新写配置请用新名。空白值一律视同未设置。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `YUANSHU_PORT` | `8787` | 服务端口 |
| `YUANSHU_HOST` | `127.0.0.1` | 监听地址；显式设置后优先于 LAN 模式 |
| `YUANSHU_LAN` | 空 | 设置为 `1` 后，在未设置 `YUANSHU_HOST` 时监听 `0.0.0.0`，供手机直接通过局域网 IP 连接 |
| `YUANSHU_CORS_ORIGINS` | 内置本地壳 origin | 逗号分隔的额外允许来源；不要填写不受信任的站点 |
| `YUANSHU_TOKEN` | 自动生成 | 访问令牌（存 `.token`） |
| `YUANSHU_CWD` | `~/pi-workspace` | 工作空间根目录 |
| `YUANSHU_TOOLS` | `read,write,edit,bash` | 允许的工具集 |
| `YUANSHU_MODEL` | `zhipu-paid/glm-5.3-flash` | 默认模型；可覆盖 |
| `YUANSHU_EXTERNAL_THINKING` | 空 | 设为 `1` 给模型挂 think 工具导出推理草稿 |
| `YUANSHU_SHARE_HOST` | 空 | 外网分享域名（可选，配置后启用分享） |
| `PI_PACKAGE` | 自动解析 | pi 引擎入口路径（这一个是上游 pi 包自己的名字，不随产品改名） |

> 兼容别名：上表每一项都可用 `PI_WEB_` 前缀代替 `YUANSHU_`，例如 `PI_WEB_PORT`／`PI_WEB_LAN`／`PI_WEB_SHARE_HOST`。

## 配置模型与密钥

### 两个文件，分工明确

| 文件 | 位置 | 内容 | 是否入库 |
|---|---|---|---|
| `models-store.json` | `~/.pi/agent/` | 模型清单（ID、接口、地址、计费） | ❌ 本地私有（仓库提供 `models.example.json` 模板） |
| `auth.json` | `~/.pi/agent/` | 各 provider 的 API 密钥 | ❌ 绝不入库 |

### 模型清单（models-store.json）

仓库提供了精简模板 [`models.example.json`](models.example.json)，包含 6 个 provider 的代表模型：

```bash
cp models.example.json ~/.pi/agent/models-store.json
```

每个模型的字段：

```json
{
  "id": "deepseek-v4-flash",      // 模型 ID（请求时使用）
  "name": "DeepSeek V4 Flash",    // 显示名
  "api": "openai-completions",     // 接口协议：openai-completions / openai-responses
  "provider": "deepseek",          // 提供方名（与 auth.json 的 key 对应）
  "baseUrl": "https://api.deepseek.com",  // API 地址
  "reasoning": true,               // 是否推理模型
  "input": ["text"],               // 支持的输入：text / image
  "cost": { "input": 0.3 },        // 计费（可选）
  "contextWindow": 1000000,        // 上下文窗口
  "maxTokens": 384000              // 最大输出
}
```

### API 密钥（auth.json）

模型文件本身**不含密钥**。密钥按 provider 名放在 `~/.pi/agent/auth.json`：

```json
{
  "deepseek": { "type": "api_key", "key": "sk-xxx", "baseUrl": "https://api.deepseek.com" },
    "openrouter": { "type": "api_key", "key": "sk-or-xxx", "baseUrl": "https://openrouter.ai/api/v1" }
}
```

- `provider` 字段（models-store.json）与 auth.json 的**顶层 key 必须同名**，服务才能找到对应密钥
- 会话记录同样在 `~/.pi/agent/sessions/`（仓库外，不提交）
- 服务器后台只做本地文件与当前进程的凭证检查；代码更新接口只在用户主动操作时执行 `git fetch/pull`，不会自动登录或推送代码。

### 添加新 provider 三步

1. `models-store.json` 加一个 provider 节点（照模板抄）
2. `auth.json` 加同名 key + API 密钥
3. 重启服务，底部模型选择器即可看到

## 外网分享（可选）

1. 将项目放入工作空间的 `外网分享/` 目录（或自定目录）
2. 配置 `YUANSHU_SHARE_HOST` 指向你的域名，并按需配置隧道（如 cloudflared）
3. 分享链接：`https://<你的域名>/<项目名>/`

## 前端与多端构建

`frontend/` 是唯一的 React 前端源码，`frontend/dist/` 是唯一构建产物源。同步脚本把同一份产物复制到服务端静态目录 `public/` 和 Tauri 目录 `app/dist/`；Capacitor 直接使用 `frontend/dist/`，避免不同 Android 壳打包出不同界面。

```bash
npm run deploy:frontend
# 等价于：build:frontend → prune-dist --apply → sync:frontend
# 旧命令 npm run build:mobile:web 仍可用，是它的别名
```

顺序不能反：`vite.config.ts` 故意 `emptyOutDir:false` 保留旧指纹分块，先清理再同步，`public/` 与 `app/dist/` 才不会拿到未清理的全集。清理只删「当前入口 + 最近 2 个发布入口」都不可达的分块。

Tauri Android 构建使用 `app/src-tauri` 的 Gradle/Tauri 工程，Capacitor Android 构建使用 Capacitor 工程；构建前先执行上面的前端命令。APK 交付文件名必须标明 ABI：单架构使用 `arm64`、`armeabi-v7a`、`x86` 或 `x86_64`，四 ABI 合包才使用 `universal`，不能把单架构包称为通用包。

Windows 发布脚本默认把 Cargo、Gradle、npm 和临时文件放到 `D:\pi-workspace\.build-cache`，正式安装包写入 `D:\pi-workspace\交付`；手动构建时也应设置 `CARGO_HOME`、`CARGO_TARGET_DIR`、`GRADLE_USER_HOME`、`npm_config_cache`、`TEMP` 和 `TMP`，避免系统盘缓存膨胀。桌面/Android 壳版本统一维护在 `app/src-tauri/tauri.conf.json` 与 `app/src-tauri/Cargo.toml`，当前为 `0.2.4`。

默认服务只监听 `127.0.0.1`，因此现有反向代理/域名指向本机端口的方式不变。需要手机直接访问电脑局域网 IP 时，显式设置 `YUANSHU_LAN=1`，并配合 Windows 防火墙和访问令牌。

## 开发

- 前端源码：`frontend/src/`（React + Vite + UnoCSS）
- 前端构建：`frontend/dist/`，用 `npm run build:frontend` 生成
- 服务端静态部署：`public/`（由 `npm run sync:frontend` 同步，不作为另一套前端源码）
- 后端：`server.mjs`（Node 原生 http）
- 版本管理：见 `CHANGELOG.md`，每次迭代递增版本号并同步版本信息

## 开源约定

- 私有信息（域名、令牌、密钥、内网地址）**绝不写入**代码与文档
- 路径不硬编码：一律环境变量 + 跨平台推导（`os.homedir()` / `process.cwd()`）
- 平台差异：Node 标准 API 优先，避免 Windows 特有命令

## License

Apache-2.0 © 2026 xueshao1716

- 允许任何人自由使用、修改、分发（含商业用途），无需付费
- 分发时必须保留原始版权与许可声明（注明原作者）
- **二次开发后分发必须显著注明基于元枢（Yuanshu）修改**

详见 [LICENSE](LICENSE)
