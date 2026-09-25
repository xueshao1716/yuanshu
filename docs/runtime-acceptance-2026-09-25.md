# 运行验收与 HTTP 正文生命周期修复（2026-09-25）

## 变更边界

- `engine/http.mjs`：缓冲 JSON/二进制请求在读完正文后才释放超时与外部取消监听。此前响应头到达即释放，慢正文可能在上层停止后继续等待。
- 保留 `httpRawFetch` 的既有流式读取生命周期，由流式调用方管理截止时间；本修复不代表所有流式超时问题均已解决。
- 未切换默认引擎/模型，未改通道密钥，未改变工坊单次 120 秒与总计 15 分钟的既有截止策略。
- 测试使用临时工作空间；继承的 Step-5 检查点先复制，原件摘要保持一致。未把生产用户文件作为测试对象。

## 已执行证据

1. HTTP 正文生命周期先红后绿：新增 5 个本地真实 HTTP 测试，修复前 4 个应拒绝而未拒绝；修复后 5/5。覆盖 JSON/二进制正文超时、收到响应头后取消及成功正文缓存重复读取。
2. `zai-coding-cn/glm-5.3-flash` 工坊真实调用：设计计划、两个区块、选区修改共 4 次，全部 `stop`。生成和修改不自动采用候选；导出成功。事后逐项核验只有指定 `border-top:4px solid #d35400` 增加，原文字、子元素、其他属性及全局 CSS/其他区块不变。
3. 生成 HTML 在 Chromium 1440×1050 与 390×844 加载，无页面错误/横向溢出；两个区块有可见内容。此检查不等同于内容审美质量承诺。
4. GLM + 真实 HTTP/SSE + 生产 run manager/store/effects/events：首次工具执行时断开订阅，后台继续读取账单、写凭据、读回凭据。3 次工具各执行一次，4 轮模型观察均为请求模型。重连从序号 2 补收 93 个事件，与全量持久事件序列完全一致，完成事件恰好一次，无重复或遗漏。凭据真实总价 68。
5. 工坊浏览器回归（可控模型响应，不冒充真实模型）：桌面/手机两尺寸均通过执行进度、刷新、失败后续做、已完成区块不重跑、候选预览、手动采用与无横向溢出；样式根/后代/伪元素/媒体查询/动画隔离通过。

## 原始本机证据位置

- GLM 工坊：`%LOCALAPPDATA%/Temp/yuanshu-website-live-rLc7HS/report.json`、`delivery.html`、桌面/手机截图。
- Step-5：`%LOCALAPPDATA%/Temp/yuanshu-website-live-7XLuCa/report.json`。
- GLM 消息流：`%LOCALAPPDATA%/Temp/yuanshu-stream-live-7sz12f/report.json`。
- 工坊浏览器：`%LOCALAPPDATA%/Temp/yuanshu-website-browser-8Bjlcu/`。
- 上述目录是本机临时验收证据，可能被系统清理，不作为其他机器已有的文件承诺。

## 明确未完成项

- Step-5 通过 `anthropic-messages` 请求返回 HTTP 403；没有静默换模型。已生成计划和首区块在恢复失败后仍保留。不能据此断言是额度/账号/服务端策略的哪一种原因，更不能声称长任务验收通过。
- 本次没有执行新的付费图片生成；历史记录的精确像素不达标限制仍有效，未用裁剪掩盖通道尺寸偏差。
- 浏览器模拟手机尺寸与服务端断连验收不等于 Android 真机锁屏、后台保活或安装升级测试。
- 继续保留服务器拆分与跨系统集成的既有延期边界。

## 可复跑入口

- `npm run verify`：隔离状态的全量测试、类型检查和非线上目录构建。
- `node scripts/website-browser-check.mjs`：使用上一步的 `tmp/verification-dist`，输出截图到临时目录。
- `node scripts/website-live-check.mjs provider/model [checkpoint-workspace]`：显式选择已配置的真实模型，会产生调用费用，不自动作为普通测试执行。
- `node scripts/run-stream-live-check.mjs provider/model`：显式付费真实模型断连验收，限制为临时账单工具。

发布、安装包及双远端结果另记，以上事实不自动等于已发布。
