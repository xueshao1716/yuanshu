# 元枢后台任务与交付可靠性：隔离验证记录

日期：2026-09-24。状态：隔离实现与自动化验证完成，已补两轮付费真实模型实测。最新天团模型复核通过，但主代理读稿仍发现内容矛盾；图片比例符合而精确像素不符。独立审查、集成与发布尚未完成，不能宣布整体验收成功。

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

## 第二轮：修订核销与图片分层取证

### 实现与回归

- 新增 team-revision 模块：把旧问题编号，修订 REVIEW 必须每项恰好返回一次 resolved/unresolved、当前稿的连续原文和理由。编号遗漏/重复、杜撰引文、裸 pass 均拒绝放行；unresolved 不能被 pass=true 绕过。
- 修订 EXEC 只接当前稿与问题清单；修订 REVIEW 不重复灌入旧稿或早期 IDEA/CHALLENGE。最多一次修订，仍是四或六个真实子任务，不增加付费循环。
- 逐项核销写入绑定产物摘要的证据，但引文存在只证明可定位，不能证明语义正确；程序口播检查继续独立阻断。
- 图片 status=matched 仅表示比例匹配，exactSize=false 也必须显示“像素尺寸未达标”警告。返回图仍是可用结果，不标工具失败或自动重购；音频/视频不受影响。
- 每次图片调用可携带独立观察回调，只记录 model/size/endpointPath/attempt/source 白名单，不写密钥、host/query、提示词、参考图。回调异常不改变生成结果；本地 HTTP 测试确认记录来自实际派发请求体且不串请求。

### 真实图片：差异在落盘之前已存在

- 原始报告：tmp/media-continuation-live-9deb9661-a251-4308-b5ad-8658162c2761.json；44039 毫秒，run completed。
- 宿主实际派发一次 POST /v1/images/generations，model=agnes-image-2.5-flash，size=1024x1536。source=host_http_dispatch 是宿主侧派发观察，不是独立上游收包证明。
- 接收到的原图 already actualSize=832x1248，落盘后仍 832×1248；exactSize=false，ratioExact=true。该样例排除了本地保存改变尺寸，但不能继续归因到供应商内部路由、适配器或模型中的哪层，也不能推导所有模型都有此限制。
- 图片 1833949 字节，SHA256：a101fe18177d85aa87964c8347b0c79686078889f8e85b59a3eee9c55b0e7ced。报告与图片均保留，未裁剪或放大。
- 生成过程中断开 SSE，后台仍完成 generate_image → write → read，3 个效果记录，1 次生成，未超时。continuationPassed=true、dimensionsPassed=false、passed=false，exit 1 如实保留。媒体通道不是“只能出方图”，而是本次精确像素没有兑现。

### 真实天团：旧项核销有效，语义漏检仍然存在

- 原始报告：tmp/team-general-live-979c3dd6-c5b9-44b4-8998-69f6f8e79a37.json；136342 毫秒，六个真实子任务完成，6 次观测均请求 glm-5.3-flash 且上游声明同 ID，全部 finishReason=stop。
- 草稿摘要：c1538997accaaa1d93a8b33d95c2ce64ebcc66c3e8ecf4fbf4b647b50249ffae。临时工作区：C:/Users/XUEXIA~1/AppData/Local/Temp/yuanshu-team-live-xtSAJy；草稿：工程/天团交付/13a49d3e-81ff-45ee-8e0e-e1942795eb42/草稿.md；核销证据在同目录核验记录.json。
- REVIEW 第一次提出三个问题，第二次为 R1/R2/R3 提供了当前稿引文和理由，模型 pass=true；草稿进入 awaiting_acceptance，reviewable=true，assistantMessages=1，humanAccepted=false。脚本 exit 0 只对应文本流程。
- **主代理读稿否决内容通过**，不是用户已完成验收，也不是独立审查。至少仍有以下反例：
  1. 第2期 3—9秒允许“两份报价加总≤50才下单，超了弃最贵那道，只拍便宜那道”；但 9—16秒仍“取餐，先拍贵的”，22—34秒仍“吃招牌”，46—54秒仍“两份并排”，54—60秒仍报“两道一共”。砍单路径缺少相应脚本。
  2. 第3期 A 的 3—10秒允许砍第三家；虽然修订后的收尾有两家/三家条件分支，40—52秒画面仍固定“三份并排逐个尝”。末尾自检声称“下单、试吃、收尾均按两家口径”，不等于正文已做到。
  3. 第3期 A 只规定任一家>18或三家总额>50则砍第三家，没有保证剩下两家≤50：例如已确认报价30、30、10，砍第三家后仍60。此为对规则的反例，不是虚构店铺实测。
- 这说明核销能挡住漏填旧项，却不能保证旧项全局解决或发现未列出的矛盾。保留失败样例；不通过删掉约束、增加付费重试或写死餐饮关键词正则来刷绿灯。真实内容质量仍未通过。
- 新增 live-eval-team-result：今后报告明确 pipelinePassed 与 contentQualityPassed=null，humanAccepted 恒为 false；不把模型或调用者传来的通过标志当成人工验收。新增3例先失败，修复后定向联测49/49。没有重写上面原始付费报告来冒充新字段实测。
- 思考档位只读核查：本机 glm-5.3-flash 配置 thinkingLevelMap={low:'low',medium:null,high:'high'}；现有 adapter 对不支持的 medium 向下映射为 low，因此 EXEC/REVIEW 请求实际为 low。未发现模型 ID 降级；尚不能判定思考档位与语义漏检的因果关系，本轮未改共享配置或强制 high。

### 本轮验证

- 核销/媒体定向先红后绿44/44；随后增加报告边界后8组联测49/49，exit 0。
- Node 25.8.2 并行运行曾额外出现 runner 的 “Unable to deserialize cloned data due to invalid or unsupported version.”，改为 test-concurrency=1 后正常。不将 runner 异常冒充业务断言失败，也未关闭业务测试。
- 初次全量2020/2020；加入3条报告边界后最终全量2023/2023、50 suites、零失败、零跳过、零取消，exit 0，127.46秒。完整日志：.verification/unit-tests-revision-final.log。
- 前端 tsc/build exit 0；既有 chunk/Toast/Vite 配置警告仍在。9个相关前端文件 Impeccable detect=[]。
- 本轮浏览器1440px/390px复验2/2，exit 0，9.46秒；日志 .verification/browser-revision-final.log。截图已刷新，工具返回“不支持图像输入”，仍不声称目视核验。
- 日志：.verification/revision-dimensions-red.log、revision-dimensions-green.log、team-outcome-red.log、revision-final-targeted.log、unit-tests-revision-final.log、frontend-build-revision.log、team-revision-live.log、media-dispatch-live.log。以上验证材料本地保留，不提交临时目录。

## 第一轮验证与证据（历史，未改写）

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
2. 两轮真实模型样例已跑：第二轮天团模型复核放行，但主代理读稿发现预算和镜头分支矛盾，内容质量仍未通过；媒体链路完成但精确像素未达标。仍需内容质量改进、明确图片通道的精确尺寸能力，以及真实外网嵌入兼容性和桌面/手机 Tauri 真机测试。不得为获得绿灯而降低复核标准或反复付费重试。
3. 与主目录并发修改对齐，审查继承快照。收尾只读检查仍见源码、版本配置及前端/客户端打包产物的未提交改动，不能覆盖或混入本轮。不要直接把含现场快照的整条分支推到 main；集成时只选择已审查的本轮提交并核查其依赖。
4. 集成后再统一版本号、重建服务目录产物、执行重启健康检查；安装包及 GitHub/Gitee 双推分别验证。

`.verification/` 与 `frontend/dist` 均为本地验证产物，不纳入本轮源码提交。保留隔离工作树供后续审查，不清理主仓现场。
