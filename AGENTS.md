# AGENTS.md —— 元枢（Yuanshu）仓库 AI 协作准则

> 产品名是**元枢 / Yuanshu**，不是 pi-web。`pi-web` 只剩两处合理用途：一是远端仓库名
> （GitHub/Gitee 上的 repo，改名需在平台操作），二是 `yuanshu` 命令的兼容别名。
> 新增代码、文案、计划任务名一律用 `yuanshu` / `元枢`；环境变量用 `YUANSHU_*`
> （`PI_WEB_*` 保留为兼容读，别删，见 `engine/env.mjs`）。

> 任何 AI 会话（小语/其他 agent）在本仓库工作时，先读本文件。本文件是**仓库级硬约定**，
> 与个人记忆无关；与记忆冲突时，以本文件为准并提醒使用者更新记忆。
> 借鉴：NiceGUI 的 AGENTS.md / REVIEW.md 实践（D:/pi-workspace/工具/参考项目/nicegui）。

## 工作纪律（每轮任务必守）

1. **TDD 先红后绿**：核心逻辑先写测试再实现；JSX/组件用源码契约断言（按行查找+行内包含，不依赖正则转义）
2. **验证后才说"已验证"**：tsc / 全量测试 / build / Impeccable detect 四件套，没跑过不许声称
3. **小步提交**：不写大文件，超 ~200 行拆模块；commit 前自查 diff 有无夹带无关改动
4. **Git 双推**：push origin main → GitHub(xueshao1716/yuanshu) + Gitee(linxinyu520xue/yuanshu)；push 前探活代理 127.0.0.1:7890
5. **交付必通报**：完成调 `python D:/pi-workspace/工程/notify.py "内容"`（活动流+微信）
6. **研究结论当日归档**：现行事实走 `upsertMemoryFact`（`section` + 可选 `topic`），同 topic 旧条作废；禁止只往记忆日志追加一条对打的现行。流水账仍可 `autoMemorize`

## 部署事实（改前端必读，踩过三次坑）

- **React 前端服务的是 `frontend/dist`**（server.mjs 的 REACT_DIST），**不是 public/**——
  `cp dist → public` 只是 git 快照用途，不是部署！
- 部署流程 = `cd frontend && npm run build` → 服务自动读盘；当前 `emptyOutDir: false` 保留旧指纹资源，避免已打开的页面懒加载 404，不要为验证清空线上 dist。
- 服务端路由改动（server.mjs / engine/*）需重启 node 进程才生效
- `lib/static.mjs` 已有 no-cache + ETag 304（index.html 会 revalidate）；
  dist 里带 hash 的 chunk 是 immutable 强缓存
- **别拿真实工作产物当测试靶子**——端到端测试用临时目录造数

## 并行会话规则（2026-09-03 踩踏事故三条教训）

1. **同一时间只允许一个会话改元枢源码**。要并行，去 `.worktrees/` 开 worktree，合并前先 rebase
2. 动手前先 `git status --short` + `git log --oneline -3`：工作区脏 = 别人在干活，**不要 checkout/stash 别人的现场**
3. 发现"改了没生效"：先对比 `curl 127.0.0.1:8787/` 的 bundle hash 与磁盘 dist 是否一致，
   再查服务进程（`Get-CimInstance Win32_Process`）是否单实例、从哪个目录起——
   历史教训：双实例抢端口（Windows 不报 EADDRINUSE）、服务内存缓存旧 index、
   两个会话轮流 build 覆盖 dist

## 验证命令速查

```bash
cd /d/pi-web && npm run verify               # 推荐：隔离工作空间，全量测试 + 类型检查 + 非线上目录构建
cd /d/pi-web && npm test                     # 直接测试不带上述隔离；不要用于生产工作空间验收
cd frontend && npx tsc --noEmit              # 类型检查
cd frontend && npm run build                 # 构建（输出 frontend/dist）
node "$HOME/.pi/agent/skills/impeccable/scripts/detect.mjs" --json <改动的前端文件>
TOKEN=$(python -c "print(open('D:/pi-web/.token').read().strip())")   # .token 含 #，curl 须用 Authorization header，不能放 URL
```

## 已知坑（不重复踩）

- bash heredoc 会吃 `\\` 转义：含正则/反斜杠的内容用 edit 工具或落 .py 文件执行
- Git Bash 的 /tmp 与 Windows Python 的 /tmp 不互通：curl -o 与 python 读文件必须在同一 cwd 下用相对路径
- esbuild/vite 产物默认不转义中文（grep 中文特征串可靠）；但 Workshop 等是**懒加载 chunk**，
  验证功能进没进产物要 grep 对应 chunk（Workshop-*.js），不是主 index bundle
- Windows 下 `node server.mjs` 双实例不会端口冲突报错，请求随机分发——查进程数再动
- 当前 Tauri 壳在 `app/src-tauri/src/lib.rs` 中：桌面加载 `http://127.0.0.1:8787/`，手机加载 `https://pi.myxinyu.xin/`。纯线上前端改动重新加载即可更新；原生桥、权限、壳配置或客户端版本变动仍需重新打包。`app/dist` 是打包资源快照，不等于当前壳的实际页面入口；以后变更入口时以代码为准。
- **禁止把探测输出追加进会越写越大的文件**（2026-09-05：某会话把一条 `Select-String ... server.mjs` 死循环写入 `D:\pi-workspace\tmp-routes.txt`，11 小时灌出 128GB，D 盘只剩 0.84GB）。探测落 `D:\pi-workspace\tmp\`，用完立刻删；单文件不许超过 50MB；PowerShell 里 `$_` 会被吃掉，别把命令文本本身写进目标文件再循环读

## 代码审查要点（review 时按此扫）

- 安全：路径穿越（凡接收 path 参数必须限定白名单目录，参照 workshop rebuild 的 outRoot 前缀校验）
- 资源：SSE 长任务必须有超时兜底 + 客户端断开不泄漏 agent
- 前端：iframe srcDoc 一律 `sandbox=""`；触屏设备按钮 touch-hit

## 作品集落地约定（2026-09-03 创作工坊产品化第一步）

- **聊天里产出 PPT 设计稿时，产物一律写 `D:/pi-workspace/workshop-out/ppthtml-<id>/`**
  （deck.json + pages/page-XX.html），资产页「作品」分区扫描自动收录，零登记仪式
- deck.json 的 slides[].file 宽容解析（带/不带 pages/ 前缀都认），但新产出统一写 `pages/page-XX.html` 相对路径
- 图像/小说类作品的画布化是后续阶段，未就绪前聊天产出仍进对应目录即可
