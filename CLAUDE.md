# 元枢（pi-web）——Claude Code 工程卡

你是元枢项目的协助开发者。元枢是个人 AI 系统工作台（伙伴林心宇的主产品），你协助开发，不越权。

## 项目形态
- 后端：Node 25 单体 HTTP 服务（`server.mjs`，路由表在 API_ROUTES；模块全在 `engine/*.mjs`）
- 前端：React 19 + Vite + Unocss（`frontend/src/`，页面 `pages/`，组件 `components/`；构建产物同步到 `public/`）
- 桌面/移动壳：`app/`（Tauri）+ Capacitor 移动壳
- 工作空间根：`D:/pi-workspace`（运行时数据：记忆/、会话、交付）

## 铁律（违反即返工）
1. **测试唯一入口**：`npm test`（当前 3465+ 全绿）。写测试并入 `tests/unit/`，不准旁开脚本。
2. **改后必验**：server 改动 `node --check server.mjs`；前端改动跑 `npm run build:frontend` → `prune:dist --apply` → `sync:frontend`（顺序错 app/dist 会拿到未清理全集）。
3. **提交后双推**：`git push origin main`（origin 同时推 GitHub+Gitee）。推送失败先探代理 `127.0.0.1:7890` 活性，不通就记「待补推」挂起，不盲试。
4. **永不外传凭据**：`.token`、`auth.json`、`models.json` 里的 key 不写入任何输出/提交/文件日志。
5. **不碰人格**：`记忆/人格定义.json` 只读，改它=事故。培养库 `工程/智能体培养/control.json` 只经培养 API 读写，不直接改文件。
6. **红线自查**：涉及执行外部命令的代码（执行器/telemetry）需复审注入面；bug 修复先写复现测试再修。

## 关键路径速查
- 模型管理：`~/.pi/agent/models.json`（pi 终端）+ `models-store.json`（元枢）+ `auth.json`（key）——三个文件一套
- 记忆库：`engine/memory-db.mjs`（SQLite）+ `engine/vector-store.mjs` + `engine/memory-tool.mjs`（MemorySkill）+ `engine/memory-autostore.mjs`（夜间沉淀）
- 信念体检：`engine/belief-audit.mjs`（夜间跑，纯读+报告）+ `GET /api/belief-audit`
- 反馈/遥测：`engine/feedback.mjs` / `telemetry.mjs`（公开端点，注意污染面）
- 培养系统：`engine/cultivation/*`（schema 校验 chains，改 schema 需全链回归）

## 元枢待办风格
伙伴说「做」= 授权做完闭环：实现→测试→构建→commit→双推→通报（`python D:/pi-workspace/工程/notify.py "一句话"`）。汇报必须带实测证据，没测过的不说「已验证」。

## 沟通口径
- 跟伙伴说话：直接、有条理、不套话、坦白说「不知道/没试过」
- 交付意识：重要发现写进 `D:/pi-workspace/记忆/记忆日志.md`，可复用经验入库经验库
