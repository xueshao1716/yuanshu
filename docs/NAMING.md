# 元枢命名契约

本文件是**命名与版本的唯一约定**。改命名规则、加类型、发版，都先改这里，再改实现，最后靠测试钉死。

- 版本唯一来源：仓库根 `version.json`
- 产品名：中文 **元枢**，英文 **Yuanshu**
- 漂移检测：`tests/unit/naming-contract.test.mjs`
- 发版命令：`npm run version:bump <major|minor|patch>`

---

## 一、版本号

### 只有一个版本号

`version.json` 是唯一来源：

```json
{ "version": "2.8.0", "product": "元枢", "productEn": "Yuanshu" }
```

其余 8 处**必须**与它一致，由测试钉死，任何一处漂移都会让测试失败：

| 文件 | 字段 | 用途 |
|---|---|---|
| `package.json` | `version` | 仓库包版本 |
| `app/package.json` | `version` | 桌面壳 |
| `frontend/package.json` | `version` | 前端包 |
| `mcp-server/package.json` | `version` | 独立 MCP 服务包 |
| `app/src-tauri/tauri.conf.json` | `version` | Tauri / 安卓壳 |
| `app/src-tauri/Cargo.toml` | `version` | Rust 壳 |
| `engine/mcp-server.mjs` | `serverInfo.version` | 内置 MCP 服务标识 |
| `mcp-server/index.mjs` | `version` | 独立 MCP 服务标识 |
| `engine/unified-chat.mjs` | `APP_VERSION` | 看板展示（**派生，不手写**） |

> ⚠️ **`engine/mcp-server.mjs` 的 `protocolVersion` 不是产品版本**，它是 MCP 协议规格版本
> （形如 `2024-11-05`），绝不能跟着产品版本一起改。测试专门盯着这一点。

### 为什么要有这个契约

在此之前版本号散在 9 个文件里各写各的，而且是**两条互不相干的线**：

| 日期 | 产品版本 | 壳版本 |
|---|---|---|
| 08-05 | — | `1.0.0` |
| 08-20 | `2.5.0` | `1.0.0` |
| 09-04 | `2.6.0` | `1.0.0` |
| 09-11 | `2.6.0` | `1.0.0` → **`0.2.2`（倒退）** |
| 09-12 | `2.7.0` → `2.7.1` | `0.2.3` → `0.2.4` |
| 09-14 | **没动** | **没动** |

三个后果：壳版本倒退过一次（两条线被当成一条用）；09-12 到 09-14 发了一整批功能但
两个号一个都没动（没有任何机制强制推进）；界面把两个都叫「版本」——系统页读
`package.json` 显示 `v0.2.4`，看板读 `APP_VERSION` 显示 `2.7.1`。

### 怎么发版

```bash
npm run version:bump patch        # 2.8.0 → 2.8.1
npm run version:bump minor        # 2.8.0 → 2.9.0
npm run version:bump major        # 2.8.0 → 3.0.0
npm run version:bump 3.1.4        # 直接指定
npm run version:bump sync         # 把所有声明对齐到 version.json（不递增、不动 CHANGELOG）
npm run version:bump minor --dry  # 预演，不落盘
```

`bump` 会顺带把 `CHANGELOG.md` 的 `## [Unreleased]` 收成 `## [x.y.z] - 日期`，并在上面
留一个空的 `[Unreleased]`。完整发版流程：

```bash
npm run version:bump minor    # 1. 改所有版本声明 + 收 CHANGELOG
#                             # 2. 补 CHANGELOG 条目
npm run build:frontend        # 3. 构建（版本会注入前端，产物名带新版本）
npm run prune:dist -- --apply # 4. 清掉历史构建遗留的不可达分块（见下）
npm run sync:frontend         # 5. 镜像到 public/ 与 app/dist/（会先清空目标再拷贝）
npm test                      # 6. 契约测试会检查全部一致
git push origin main          # 7. 双推
```

### 为什么第 4 步不能省

`vite.config.ts` 里 `emptyOutDir: false` 是**故意的**——保留上一版指纹资源，避免还开着旧
`index.html` 的客户端懒加载新模块时 404。代价是**每次构建都会新增一整套分块**
（约 190 个 / 6 MB），而 `sync:frontend` 是忠实镜像，会把这套垃圾一起复制进 `public/` 和
`app/dist/`。于是三棵树各自无限膨胀：不清理的话，发一次版就往仓库里多加约 570 个文件。

`scripts/prune-dist.mjs` 的判据是可解释的，不靠猜：从「当前 `dist/index.html`」和**最近 2 个
改过 `index.html` 的提交**出发做可达性遍历，只有所有这些入口都到不了的指纹分块才删。
也就是说，当前版本依赖的文件一个都不会删，上一个发布版本也仍然完整可用（要更保守用 `--keep 3`）。
它只碰 `frontend/dist/assets` 下匹配 vite 指纹格式的文件，手写资源（favicon、manifest 等）一律不动。

删完必须再跑一次 `sync:frontend`——否则 `public/` 与 `app/dist/` 里仍是裁剪前的旧副本。

---

## 二、产物命名

### 格式

```
{提示词摘要}_{类型}_{YYYYMMDD-HHmmss-mmm}-{唯一id}_{v版本}{扩展名}
```

例：

```
拳手在雨夜的车站等到天亮_视频_20260914-181230-456-a1b2c3d4_v2.8.0.mp4
小语肖像_图片_20260914-181245-120-9f8e7d6c_v2.8.0.png
未命名_音乐_20260914-181300-330-11223344_v2.8.0.mp3
```

各段职责：

| 段 | 规则 |
|---|---|
| 提示词摘要 | 提示词前 32 字，去掉 `\ / : * ? " < > \|` 与控制字符，空白折成 `-`；空则回退 **`元枢`**（前后端同一个兜底值） |
| 类型 | 见下表；未知类型 → `产物` |
| 时间戳 | 本地时间 `YYYYMMDD-HHmmss-mmm`（毫秒，保证同秒内也可区分） |
| 唯一 id | 8 位随机十六进制（后端最多 16 位） |
| 版本 | `v` + `version.json` 的版本 |
| 扩展名 | 见下表；未知类型 → 空（调用方按实际文件后缀补） |

### 类型表

前端 `frontend/src/lib/artifact-name.ts` 与后端 `engine/workspace-api.mjs` **必须逐项一致**
（测试会解析两份源码比对，防漂移）：

| 类型 | 标签 | 扩展名 |
|---|---|---|
| `image` | 图片 | `.png` |
| `video` | 视频 | `.mp4` |
| `audio` | 音频 | `.wav` |
| `music` | 音乐 | `.mp3` |
| `text` / `novel` | 文本 | `.txt` |
| `document` / `doc` | 文档 | `.md` |
| `ppt` | 演示 | `.pptx` |
| `html` | 网页 | `.html` |
| `code` | 代码 | `.txt` |

加新类型时：**两份表一起加**，然后跑 `npm run version:bump patch`（新类型算功能，按需 minor）。

### 为什么带版本

以前产物名里没有任何版本信息，升级后产出的文件跟旧版混在一起分不清；而聊天里的下载名
更是直接回退成 `元枢视频-1.mp4`、`元枢视频-2.mp4`——**所有视频同名、互相覆盖**，
文件链接的下载名甚至是字面量 `download`（连扩展名都没有）。版本进名字后，
「这个视频是哪个版本做的」看文件名就知道，也让版本号真正**可观测**。

### 落点

| 场景 | 实现 |
|---|---|
| 后端媒体落盘 | `engine/workspace-api.mjs` → `saveArtifact` / `saveArtifactFromFile` → `artifactBaseName` |
| 聊天里的媒体下载 | `frontend/src/lib/artifact-name.ts` → `artifactName()`；优先用签名 URL 里后端已命名的真实文件名（`fileNameFromUrl`） |
| 文件链接下载 | 同上；从扩展名反推类型，绝不回退成 `download` |
| 主题导出 | `yuanshu-theme-{主题}.css` |

### 显示名与文件名分开

播放器、列表里显示的短标签**不承担契约**（`视频 1` 之类即可），带时间戳的全名只在
**下载时**使用。契约管的是落盘/下载的文件名，不是界面文案。

前端生成下载名时必须 **memo**：`artifactName()` 每次都产生新的随机 id，
在 render 里现算会导致显示的名字每帧都变、点下载拿到的也不是刚显示的那个。

---

## 三、产物本地化

### 规则

**外站 API（出图 / 出片 / 配音）返回的产物，必须先下载到本地工作区再入库。**

外站给的多是**临时链接**，几小时到几天就失效。把外站 URL 当成品存下来，
等于存了一个会自己死掉的引用。

落地位置与命名同第二节：`生成物/{类型}/{日期}/{契约名}`。

### 返回值

`saveArtifact(artifact)` 返回结构体，而不是一个字符串：

| 字段 | 含义 |
|---|---|
| `url` | 该用的地址。落盘成功 = 本地签名地址；失败 = 原外站地址（至少让界面还能显示） |
| `local` | 是否已经真的落在本地工作区 |
| `reason` | 没落盘的原因（`local=false` 时一定有），供上层**如实告诉用户** |

只关心地址的调用方用 `saveArtifactUrl(artifact)`（薄封装，返回字符串）。
**需要知道有没有真落盘的，必须用 `saveArtifact` 检查 `local`。**

### 失败时怎么办

不允许"悄悄降级"。`local=false` 时调用方必须把 `localizeError` 带出去并提示用户，
例如：

> ⚠️ 视频已生成，但没能存到本地（下载失败 HTTP 502）。当前显示的是外站临时链接，
> 过期后会失效，请尽快下载保存。

内网/回环地址会被 SSRF 守卫拦下（这是安全上正确的），但**同样算未本地化**，
如实标记，不假装成功。

### 重试与校验

- 下载失败**重试一次**（上游 CDN 抖动很常见）。
- 落盘后校验文件**非空**；空文件会让"已本地化"变成另一句假话。
- 图片额外校验 magic bytes，防止 HTML 错误页冒充图片。

### 大小与超时（2026-11-07）

| 类型 | 上限 | 超时 | 落盘方式 |
|---|---|---|---|
| 图片 / 音频 | 50MB | 60 秒 | 整包读入后写盘 |
| 视频 | 500MB | 10 分钟 | 流式写 `<目标>.part`，完整后 rename |

视频不能 `arrayBuffer()` 整包读进内存（几百 MB 的成片会瞬时占满堆，并发几部就 OOM），
而是边下边写：先写临时文件 `.part`，校验非空后再原子改名为最终产物；
中途失败、超时或取消一律删掉临时文件，按"没本地化"如实回报（`local=false` + `reason`），
语义与上面一致——**下不下来就是失败，绝不悄悄降级**。

上限集中定义在 `engine/workspace-api.mjs` 的 `ARTIFACT_DOWNLOAD_LIMITS`，
运维可用 `PI_ARTIFACT_MAX_MB` / `PI_ARTIFACT_TIMEOUT_MS` 覆盖；
测试可用 `artifact.limits` 单独注入。

### 为什么要有这个契约

`saveArtifact` 原先在下载失败时 `catch` 住、**悄悄把外站 URL 原样返回**；
调用方里还有三处 `try { ... } catch {}` / `.catch(() => null)` 把它吞掉。
结果是"已落盘"和"没落盘"在界面上**完全一样**，等外站链接过期才发现产物根本不在本地。

### 测试怎么模拟外站

不能真起本地 HTTP 服务器——SSRF 守卫会（正确地）拦掉回环地址。
用 `initWorkspaceApi({ fetchImpl })` 注入下载器，既不放宽安全策略，
又能在生产同一条代码路径上验证。见 `tests/unit/artifact-localize.test.mjs`。

---

## 四、证据回读

### 规则

**压缩可以省掉「重复」，不能省掉「证据」。** 每一次压缩都要能回答三个问题：

1. 原件在哪
2. 怎么逐字回读
3. 失败信号有没有被省掉

### 工具结果压缩

`shrinkToolResult` 超过 `TURN_END_RESULT_CAP`（9000 字符）时压缩，做法：

- **头尾按整行截断** —— 绝不把一行切成半句。半句话比没有更误导。
  （退化情形：整个结果只有一行且超预算时不得不切，会在提示里注明「边界未按整行对齐」）
- **原件归档**到 `<agentDir>/yuanshu-tool-results/tr_<sha256前24位>.txt`。
  内容寻址 → 同一份原文永远同一地址，反复投影只校验不重写。
- **指针必须可执行**：给出绝对路径 + 一条现成的读取命令
  （`read` 工具读该文件，或 `sed -n '<起>,<止>p' <path>`）。
- **失败信号守卫**：扫描被省略的中段，命中失败特征就**摘出来并带原文行号**，
  明确标注「不要当成成功」。报错常出现在中段（前有构建输出、后有收尾统计），
  静默丢掉等于永久丢失。

### 归档不可用时

如实说「原件未归档（归档不可用），如需完整内容请重新执行该命令」。

**绝不写「如需完整内容可重新读取」却又不给指针** —— 那是一句模型无法执行的空头承诺。

### 大结果先发全文 N 次

`FULL_SENDS = 2`：够长的工具结果**前两次投影仍发全文**，之后才压缩。
模型可能**还在用**这个结果，一出现就砍掉会饿死正在读它的模型。

元枢的语义要说清（和 SoL-Pi 不完全等价）：

- `formatSessionHistory` 每**请求**只调用一次，而多轮 agentic 循环（最多 20 轮）
  复用同一份 history；结果产生的那一轮里本来就是全文。
- 所以 `FULL_SENDS = 2` 的实际含义是：**结果产生后的头两次请求仍给全文，第三次起压缩**。
- SoL-Pi 数的是循环内**每一次 provider 请求**，元枢数的是**请求数** ——
  比它更宽松（更省不下 token，但更不容易丢证据）。这是有意的取舍。

计数按 `tool_call_id` 区分；没有 id 时退回内容寻址（同一份内容共享计数）。
计数在内存里、有上限（超 4000 条淘汰最早的一批），进程重启后归零——
重新多给两次全文只是浪费一点 token，不会出错。

### 归档写入安全

借 NVlabs/SoL-Pi 的 ObservationPack 几条细节：

- 目录 `0o700`、文件 `0o600`
- 用 `wx`（`O_CREAT|O_EXCL`）创建，并发/重入不互相覆盖
- 复用既有对象前**逐字节校验 size 与 hash**；不是普通文件（含符号链接）或对不上号就拒绝复用
- 宁可归档失败并如实上报，也不让对不上号的副本冒充原件

### 为什么要有这个契约

`shrinkToolResult` 原先砍掉中间段后只说「如需完整内容可重新读取」——
没给路径、没给 id、中间段也没有任何归档。模型想照做也无从下手。

这个纪律来自 NVlabs/SoL-Pi 的 Evidence-Preserving Reducer：
**模型给的摘要是断言，不是事实**，所以每条都要能被机器验证
（逐字引用、源码 hash 对齐、失败态必须带失败证据）。详见 `docs/sol-pi-notes.md`。

---

## 五、不在契约范围内

以下是**内部标识**，不是产物名，用户看不见，为兼容性保留原样，不要顺手改：

- `pi-theme-changed` —— 主题同步用的 CustomEvent 名（3 个文件一致）
- `pi-wallpaper` —— 布局 DOM id
- `pi_web_token` / `pi_api_base` —— localStorage 旧键（`yuanshu_*` 为主，旧键兼容读）
- `~/.pi/agent/`、`pi-workspace`、`RUNS_DIR=pi-web-runs` —— 既有数据目录，改名会丢数据
- `PI_PACKAGE` —— 上游 pi 包自己的环境变量名
- `protocolVersion` —— MCP 协议规格版本
