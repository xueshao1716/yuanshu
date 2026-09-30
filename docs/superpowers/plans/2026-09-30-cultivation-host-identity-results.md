# 培养母体身份：宿主接线验收记录

日期：2026-09-30。分支：`feat/agent-cultivation-ecology`。代码提交：`322b6da4`。

这是培养系统的身份基础增量，不是完整产品或线上启用记录。保持隔离工作树，不合并、不推送、不重启、不调用真实模型、不修改基因或业务培养记录。

## 已实现与检查

- run-manager 为每次执行签发内存对象身份，调用方请求中的 `__runContext` 被宿主替换。该身份不可枚举，不进入 JSON、持久请求和常规上下文展开。
- 每次解析重验当前任务状态、宿主、会话、执行代次、工作区及期限。停止、结束、异常、释放、失效检查或时钟倒退使旧身份不可恢复；续跑签发新身份。
- 母体适配器绑定实际活动 entry、session manager 和 generation，并通过真实 `canAccessSessionOrigin` 再核会话来源。知识后台、子智能体来源、天团和已获语音任务准入的执行不能取得母体身份。
- 持久化的 `motherIdentityEligible` 仅是限制条件，不是凭据，由管理器计算并覆盖请求值。缺少宿主标记的旧记录不会获得母体权限。生成和解析均再次核验持久请求类别。
- server 在当前会话置忙和 generation 确定后绑定；启动仅安装母体解析器。没有安装人工或 HTTP 写身份解析器，没有增加可调用培养工具。
- 人工适配器缺失时 `writeIdentityAvailable=false`，运行时所有修改仍拒绝；HTTP 写入口在读取请求体前返回 503。不会把 bearer、本机来源或请求自报的身份当成人工批准。

内存身份不能抵抗同进程任意代码执行或本机管理员。本轮没有证明全量执行路径均可消费该身份；普通上下文展开会有意丢弃它，专用工具接入仍待实现。

## 验证实据

最新联合回归：**224 项，223 通过，0 失败，1 跳过，退出码 0，18.5 秒**。隔离临时目录后缀 `1uHZUD`。前一次 `t2skiW` 同为 223 通过、0 失败、1 跳过。

29 个相关测试文件，按并发 1 执行：

- 培养：api、controls、control-state、designs、host-identity、identity、policy、projection、recovery、state、storage。
- 任务：execution-identity、api、manager、store、background-recovery、continuation-e2e、activity、observability、effects、event-log。
- 会话/语音：session-origin-auth、session-origin-boundary、voice-run-admission。
- 知识：storage、store、budget、api；另含 server-cache-contract。

使用 `verificationEnvironment`、`verification-preload` 与独立临时目录，不运行会写业务工作区的裸 `npm test`。宿主测试调用真实 session-manager 来源校验函数，但会话管理器对象和历史文件是临时合成数据；没有运行真实服务器或浏览器。

另已执行：9 个改动或新增 JS 文件 `node --check`、工作区与暂存 diff 检查。自查确认只有计划内文件，母体权限不进入通用子任务上下文，也没有人工批准旁路。对本轮 10 个源码/测试/计划文件的有限凭据模式扫描无匹配；不是全库或历史泄露审计。

跳过项为 session-origin-auth 的文件符号链接测试：Windows 返回 `EPERM`，不计为通过。硬链接和目录 junction 边界测试通过；未修改系统权限规避该限制。

## 中途问题与处理

1. 初始 continuation 测试无法导入稀疏工作树未展开的 `code-mode`。只在本工作树用 `git sparse-checkout add code-mode` 展开 HEAD 已跟踪的目录，没有复制主工作区源码。之后 continuation 两项通过，并纳入最终联合回归。
2. 持久请求变为知识后台任务时，初始实现仍返回母体身份；失败回归捕获后，在签发与解析两处重验资格，修复后转绿。增加会话替换、元数据恢复不复活身份的覆盖。
3. 独立审阅通道重复收到空任务正文，审阅者未检查或修改文件。不把空回复计作审查通过，也不继续盲重试；本轮使用单写者自查，合并门槛保留。

## 未完成的门槛

- 有效独立审阅，以及主线并入前的冲突核查。
- 真实人工身份/授权渠道与逐操作批准，专用母体工具消费链。
- 有界子智能体执行、共享资源预算、真实用量结算。
- 可追溯经验回流、aibody 土壤与情感多样性观察、用户观察面板。
- 全仓测试、前端类型检查/构建、Impeccable、浏览器/移动端、真实服务验收。

本轮不升级产品版本、不打包客户端；没有替小语编写或批准真实人物设计。后续功能必须保持默认拒绝，不能为打开界面而绕开这些门槛。

## 交付状态

代码已本地提交，隔离分支保留。按仓库约定发送阶段通报：活动流 HTTP 返回成功；微信未配置，因此未发送微信通知。通知仅报告上述有限交付，不代表完整培养系统完工或用户已阅读。
