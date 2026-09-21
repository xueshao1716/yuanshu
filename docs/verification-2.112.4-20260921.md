# 元枢 2.112.4 收尾验收记录

日期：2026-09-21。范围：D:/pi-web 网页服务与当前工作区。此记录不将模型内容质量等同于单元测试通过。后续已按用户要求完成桌面和安卓安装包，见 [安装包验证记录](packaging-2.112.4-20260921.md)。

## 自动验证

- 使用 `node scripts/verify-workbench.mjs` 完成与 npm test 相同的全量单元测试集合，串行运行；工作区变量均指向独立临时目录。
- 1740/1740 通过，50 suites，失败、取消、跳过均为 0。
- TypeScript `tsc --noEmit` 通过。
- 隔离 Vite 构建通过；另执行 `npm run build:frontend`，正式产物输出 frontend/dist，退出 0。
- 修改的前端组件执行 Impeccable detect，结果为 `[]`；此静态结果不等同于完整可访问性或所有设备视觉验收。
- `git diff --check` 通过。
- 工作台证据：tmp/review-verification.json，记录时间 2026-09-21T07:24:26.272Z；当前源码指纹核对为 passed。
- 单元测试原始日志：tmp/verification-unit.log；类型和隔离构建日志：tmp/verification-types.log、tmp/verification-build.log。

第一轮为 1739/1740：重启测试使用固定 6 秒阈值，Windows PowerShell 冷启动导致误报，单独复现用时 6.47 秒。现改为检查启动器返回退出码 7 后，其后台测试进程仍存活，并在 finally 中清理该测试进程。定向测试通过；在内存测试副本里重新加入 `Start-Process -Wait` 后，测试如预期失败。未为此次测试终止或重启线上服务。

## 线上核对

- `/api/health`：200，ok=true。
- `/api/frontend-version`：appVersion=2.112.4，version=2112004。
- 8787 只有一个监听者，PID 23620；早前读取的父进程为 watchdog PID 8488。
- `/api/tasks/active`：active=false；天团 launch=null。
- `/api/engine/pair`：primary=pi，secondary=yuanshu，lead=pi；冻结本地评测 24/24。此数字不代表真实模型复杂任务全面通过。
- 首页引用的构建资源与 frontend/dist/index.html 一致；引用的 5 个 JS/CSS 资源均返回 200，响应内容与磁盘逐字节一致。
- server.log 最后修改时间为 2026-09-01 00:59:52，其中 EISDIR 是旧日志证据；本次检查未发现 crash.log，watchdog.log 未较本轮开始新增内容。不能以旧日志断言当前启动失败。

## 真实任务证据与边界

已有图片后继续工具任务已核对真实会话尾部：assistant/bash → 成功 toolResult → assistant/write → 成功 toolResult → assistant/stop；文本模型 glm-5.3-flash。本次没有再次调用生图或视频工具。

验收文件：D:/pi-workspace/工程/多AI角色扮演系统/验收/image-followup-check.md。该文件记录图片为 937775 字节、1024×1024，本次也读取 PNG 文件头和实际字节数核实一致。

天团真实复杂任务保留原始结果：

- runId：live-VIDEO-14b3a25a-8154-4ee4-8545-46875c548549。
- 文本模型：zai-coding-cn/glm-5.3。
- snapshotKind=history，delivery.status=quality_failed，清单 11/12。
- 唯一失败 V-02：要求 3 镜相加 10 秒，实际 4 镜×2.5 秒。总时长正确不能替代镜数约束；未改写或改判历史记录。

## 保留的后续工作

1. 将真实脚本的镜数/节奏遵循率作为新运行的验收项，保留失败样本；一条通过样本也不能证明两引擎全场景等价。
2. 默认主驾继续为 Pi。切换前仍需按同一任务集比较真实模型的完成率、工具链、失败恢复和成本。
3. 构建仍有大于 500 kB 分块、Toast 混合导入、Vite 插件弃用提示，可另做性能和依赖迁移；本次均不阻断构建。
4. 网页验收完成后，已继续生成 Windows x64 安装程序和 Android arm64 APK，内部版本均为 2.112.4，详见安装包验证记录；尚未执行覆盖安装或手机真机测试。未推送仓库，未发送外部通知。

正式构建前已备份 frontend/dist 到 C:/Users/XUEXIA~1/AppData/Local/Temp/yuanshu-web-dist-bf23045ea76645f093f73b60c2f44288/frontend-dist。构建保留旧指纹资源；未 checkout、stash、reset 或清理用户已有源码改动。
