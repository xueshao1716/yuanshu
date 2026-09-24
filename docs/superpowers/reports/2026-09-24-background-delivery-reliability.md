# 元枢后台任务与交付可靠性：隔离验证记录

日期：2026-09-24。状态：隔离实现与自动化验证完成，已补付费真实模型实测；真实内容与精确图片尺寸仍有未通过项，独立审查、集成与发布尚未完成。

## 交付边界

- 工作树：`D:/pi-web/.worktrees/muse-reliability-20260924`。
- 分支：`codex/muse-reliability-20260924`；产品版本仍为 `2.115.18`，未作为新版本发布。
- 本轮实现基线：`25671d14ee27012003b49b27d796131c54448466`。它是已有本地现场快照，不是本轮成果；与 main 的共同基线是 `48adce4f06dcb90a0c8ff5bbd0ae0033c1b72619`。
- 未合并主目录，未重启 8787，未部署，未生成安装包，未双推。主目录原有改动保持原状。
- 不包含暂缓的 OpenClaw/Hermes/曦统一接入，不修改人格、高风险权限或默认主引擎。

## 完成的实现

### 后台连续性

新任务持久化自动恢复策略，每段最多 30 分钟、最多自动接续 3 次、从创建起最多 2 小时。历史任务不自动加入。只对执行预算暂停和服务重启尝试自动恢复，并重新核查：

- 检查点版本、内容摘要、工具调用与结果完整性。
- 效果账本可读且已完成，不自动重放在途或不确定副作用。
- 用户停止、审批等待、工作区变化、天团在途、次数/期限耗尽、同会话其他任务均阻断。
- 已预约的恢复跨进程重建不重复扣次数；关闭自动接续不停止当前执行。

收尾补测发现：自动接续因网络失败后，策略仍标记 running，日后手动继续可能继承已过期窗口，执行时限仅为 1 毫秒。修复为按内部调度来源区分自动/手动：手动继续获取新的 30 分钟有界预算，不重置自动恢复次数和总期限；自动续接仍受剩余窗口限制。

复现证据：新增用例首次运行 18/19，通过数之外的唯一失败为 `1 !== 1800000`；修复后后台恢复、接缝、真实执行循环联测合计 28/28。

### 天团交付与下载

- 复用 IDEA/CHALLENGE/EXEC/REVIEW 子任务链路，生成草稿、验收稿与核验记录；绑定 run、session、workspace、产物摘要和证据。
- 先写草稿和提交意图，再进入人工待审，不自动批准。观察状态时重新检查文件、提案和摘要，改稿后旧验收失效。
- 验证范围明确为 `text_pipeline_only`，程序检查与模型复核不冒充真实图片、视频或人工验收。
- 下载通过受保护请求发送 Authorization header，不把 token 塞进下载 URL；失败显示错误，不在鉴权失败时用裸跳转冒充下载成功。

### 会话媒体与内置浏览器

- 恢复媒体仅来自当前会话最后一条用户消息之后的 assistant 内容，不扫描其他会话或工具正文。
- 按工作区路径归一化去重，外部地址保留主机和查询差异，已复用但尚未交付的媒体仍可展示。
- 浏览器补返回、前后退、复制结果提示、加载超时与刷新；保留 iframe sandbox，拒绝 javascript 地址。
- 复制兼容路径恢复原有焦点和选区；iframe onLoad 不宣称可以读取或确认跨域页面内容。

## 真实模型验收补充

### 天团：执行链跑完，但内容未过复核

- 记录：tmp/team-general-live-1563830e-1768-458a-b69f-f5039f53728c.json；149481 毫秒。
- 文本模型请求为 zai-coding-cn/glm-5.3-flash。验收记录区分请求模型与上游响应声明的 model 字段，不把配置值当成独立身份证明。
- IDEA → CHALLENGE → EXEC → REVIEW → EXEC 修订 → REVIEW，共 6 个真实子任务完成；响应为正常 stop，并非输出截断。
- 最终仍有两处内容矛盾：预算超限允许砍单，却预设“三份买齐、没超50”的口播；声称删除两处无声试吃，实际上只有一处。
- 正确拒绝发布：status=failed，reviewable=false，assistantMessages=0，humanAccepted=false，AIBody 标记 failed。不能写成“真实内容验收通过”。
- 已修正天团正文传输：IDEA/CHALLENGE/EXEC 使用普通多行正文，不强迫把整稿转义为 JSON 字符串；REVIEW 仍严格解析 pass:boolean / issues:string[]，无效复核不能放行。

### 生图后继续工具：链路完成，精确像素未达标

- 记录：tmp/media-continuation-live-fc46cd8f-9e1a-4b1c-80ca-e7b1be9613d2.json；51362 毫秒。
- 文本模型请求为 zai-coding-cn/glm-5.3-flash，4 次引擎观测同 ID；这是引擎观测，不是独立的上游身份核验。媒体配置为 agnes/agnes-image-2.5-flash，执行引擎为 yuanshu/unifiedChat，三类事实分开记录。
- 生图开始时主动断开 SSE 订阅，后台仍完成 generate_image → write → read；run 状态 completed，3 个效果记录，1 次生图工具尝试，无超时。没有再次付费复跑或裁剪伪装达标。
- 请求 1024×1536，实际 832×1248：精确 2:3 比例达标，精确像素未达标。因此原始报告 passed=false、进程 exit 1，不能将其解读为工具链中断，也不能声称整体验收通过。
- 检查真实图片字节、尺寸与 SHA256，以及报告中的随机标记、图片相对路径、真实尺寸和摘要。报告落盘后完整读回，再核对文件与图片未被改写。
- 验收工具限制为一次生图及临时目录的 delivery.md 读写，禁止任意磁盘读取、跨目录写入和不确定副作用自动重试。工具内部可能针对不支持的端点尝试兼容地址，不能将“一次工具尝试”写成“一条 HTTP 请求”。
- 验收脚本最多 12 轮、8 分钟，关闭自动接续；媒体上游取消没有得到确认，明确记录 upstreamCancellationConfirmed=false。
- 这次跑的是实际模型、真实工具、run-manager/store/effects/event-log 和 SSE API 组合，不是完整线上 HTTP 入口、真实手机熄屏或 Tauri 真机测试。

### 验收工具收尾修正

- 分开输出 continuationPassed（文件证据完整且读回一致）和 dimensionsPassed（精确尺寸及比例），整体 passed 必须两者均通过；实跑脚本还要求后台状态 completed、已断开订阅且未超时。
- 增加 832×1248、缺证据、读回后修改报告等回归；保留原始付费报告，不回写为新字段或冒充再次实测。
- 天团验收入口与媒体入口统一先建立临时工作区、设置两种兼容环境变量，再动态加载引擎，避免模块提前捕获真实工作区路径。
- 本次新增/调整边界测试先出现预期失败（12 项中 6 项失败），修正后验收工具、模型选择与天团联测 25/25 通过。

## 验证与证据

| 项目 | 结果及范围 |
| --- | --- |
| 新增手动继续边界 + 后台恢复/循环联测 | 28/28 通过，exit 0 |
| 验收边界、模型选择与天团定向联测 | 25/25 通过，exit 0；不再次调用付费模型 |
| 全量 Node 单测 | 收尾最终复验 2014/2014，50 suites，零跳过、零失败，exit 0（125.4 秒） |
| 桌面 1440px + 手机 390px | 真 React/Vite/Chromium，2/2 通过，exit 0 |
| 前端类型检查与生产构建 | `npm --prefix frontend run build` 内含 `tsc --noEmit -p tsconfig.json`，exit 0 |
| Impeccable 静态设计检查 | 本轮 9 个前端文件结果 `[]`，exit 0 |
| 语法与空白检查 | `node --check server.mjs`、`node --check engine/run-manager.mjs`、`git diff --check` 通过 |

浏览器断言覆盖：关闭自动接续失败后重试；天团验收入口；草稿下载实际内容与文件名；header 鉴权和无 URL token；核验文件 404；手机面板全屏与无横向溢出；复制成功和权限拒绝；悬挂页面超时；刷新清除旧错误；显式返回、系统后退和当前窗口导航后返回。两种尺寸均无 pageerror，也无非预期外部/API 请求。

执行循环联测使用真实 unifiedChat、run manager、磁盘 store/effects/event log 与 SSE API，模型供应商响应使用本地 JSON fixture。覆盖两会话、预算暂停和新进程 owner 恢复、SSE 断开后继续、游标重连不重复及工具各写一次。它不是付费真实模型或完整线上服务验收。

构建仍有已有警告：npm allow-scripts 配置、Vite 插件弃用项、Toast 静态/动态混用导入、部分 chunk 大于 500 kB。未借本轮顺手升级共享依赖。

本地证据目录（不提交）：`.verification/unit-tests-acceptance-final.log`、`.verification/frontend-build-media-final.log`、`.verification/browser-media-final.log`；两次付费报告位于上文列明的 tmp 文件。截图 reliability-1440.png、reliability-390.png、browser-1440.png、browser-390.png 均在 .verification 内。截图已生成，当前工具不支持目视查看，因此只报告自动化断言通过。

## 复跑方式

在上述隔离工作树执行，先将 `YUANSHU_CWD` 和兼容变量 `PI_WEB_CWD` 指向该工作树的 `.verification/workspace`，不要使用真实作品目录：

```powershell
$env:YUANSHU_CWD=(Resolve-Path .verification/workspace).Path
$env:PI_WEB_CWD=$env:YUANSHU_CWD
node --test --test-concurrency=1 tests/unit/*.test.mjs
npm --prefix frontend run build
$env:YUANSHU_PLAYWRIGHT_MODULE='file:///D:/pi-web/.worktrees/muse-reliability-20260924/.verification/browser-deps/node_modules/playwright/index.mjs'
node --test tests/e2e/reliability-ui.playwright.mjs
```

浏览器测试依赖当前隔离 Playwright 安装及 Chromium；该临时依赖不进仓库，也未安装到主项目共享 node_modules。

## 尚未完成的发布门槛

1. 独立规格/质量复查：本轮是主代理自审，没有新增独立审查者；不能把自审写成独立验收。
2. 真实模型样例已跑：天团内容复核未通过，媒体链路完成但精确像素未达标。仍需内容质量改进、明确图片通道的精确尺寸能力，以及真实外网嵌入兼容性和桌面/手机 Tauri 真机测试。不得为获得绿灯而降低复核标准或反复付费重试。
3. 与主目录并发修改对齐，审查继承快照。收尾只读检查仍见源码、版本配置及前端/客户端打包产物的未提交改动，不能覆盖或混入本轮。不要直接把含现场快照的整条分支推到 main；集成时只选择已审查的本轮提交并核查其依赖。
4. 集成后再统一版本号、重建服务目录产物、执行重启健康检查；安装包及 GitHub/Gitee 双推分别验证。

`.verification/` 与 `frontend/dist` 均为本地验证产物，不纳入本轮源码提交。保留隔离工作树供后续审查，不清理主仓现场。
