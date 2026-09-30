# 元枢自主培养：第一阶段执行验收

日期：2026-09-30。分支：`feat/agent-cultivation-ecology`。

## 已交付范围

内部基础模块已实现，不是已开放的智能体培养产品。未接 HTTP、前端、模型或后台任务；未初始化母体基因/情绪模块，未修改真实培养、人格、授权或知识数据。

| 模块 | 实际能力 | 提交 |
| --- | --- | --- |
| policy | 默认禁用、零预算、明确期限、模型/工具/数据白名单、禁止递归、静态请求校验 | `a925e501` |
| state | 工作区/个体信封、深拷贝、单调版本与时间、状态和审计同时生成、满 256 条拒绝新增 | `0d5c58bf` |
| storage | 固定安全路径、2MiB 有界读写、锁内版本检查、原子提交、异常不覆盖、排队前输入快照 | `8160f27a` |

storage 提交同时在 state 提取 `clonePayload`，让两个入口共享克隆前严格校验；没有修改既有母体或知识实现。三个生产模块均少于 100 行。

## 实际红绿过程

三个模块先分别创建测试，实际运行均以缺少对应模块 `ERR_MODULE_NOT_FOUND` 退出 1，再写实现。

| 阶段 | 观察到的失败 | 修正和复验 |
| --- | --- | --- |
| policy | 新加 `Array(1)` 检查后，两个断言缺少预期异常 | 白名单迭代显式检查空洞；3/3 通过 |
| state | 带数组附加属性/隐藏属性的 payload 被允许 | 检查自有属性描述符，拒绝 symbol、非枚举、访问器、数组附加属性；4/4 通过 |
| storage | Windows 夹具清理抛 `ENOTEMPTY`，连续两次复现；功能断言未报错 | 在删除目标前先解除自建 junction，安全测试保留且不跳过 |
| storage | `structuredClone` 先执行会丢弃非法字段，新增拒绝测试实际失败 | 在克隆前共用 payload 校验，getter 不执行；6/6 通过 |

另外实测了时间倒退钳制、深层数据拒绝、空读取零写盘、control 与个体隔离、复制到另一工作区/个体后拒绝、等待锁时输入修改不影响落盘、损坏/超限旧文件不能重建覆盖、硬链接读写均拒绝。

故障注入只证明本次测试中写入前失败不会更改原文件/审计；不把它冒充断电持久性或所有文件系统故障保证。恢复测试是重新构造存储实例读取，不是实际重启宿主服务。

## 联合验收

通过既有 `verificationEnvironment` 和 `verification-preload` 在合成临时目录执行；未运行裸 `npm test`。

| 测试文件 | 通过 |
| --- | ---: |
| cultivation-policy | 3 |
| cultivation-state | 4 |
| cultivation-storage | 6 |
| knowledge-storage / knowledge-store / knowledge-budget | 合计 10 |
| 合计 | 23 |

两次联合运行均退出 0：每次 23 passed、0 failed、0 skipped。验收根目录为系统临时目录下 `yuanshu-cultivation-check-kySywF`，最终复验为 `yuanshu-cultivation-check-nCD85A`。

各模块首次红阶段的临时根后缀依次为 `HzjMM1`、`mEGXAp`、`5mqMMj`；输入边界红阶段为 `e4A5yr`、`rwsAZ5`、`IR4xuV`，均使用 `yuanshu-cultivation-check-` 前缀。

`git diff --check` 通过；培养目录对 `gene.mjs`、`emotion.mjs`、`setInterval`、`fetch(` 扫描无匹配。提交范围只有培养模块、对应测试和计划/验收文档；未夹带主目录立绘或构建资产。

## 临时夹具清理记录

两次旧清理失败留下系统临时目录中的 `yuanshu-cultivation-storage-M1DTjl` 和 `yuanshu-cultivation-storage-XQtGcm`。只含本轮合成数据和内部 junction。人工补清理命令被宿主安全策略拒绝，未绕过、未声称已删除；后续采用修正后的清理顺序，测试正常退出。

## 仍未完成或验证

- 可信人类控制/作者身份、设计业务规则和用户控制接口（阶段 2）。
- 跨进程压力、实际服务重启对账、共同预算预留及真实模型任务（阶段 2/3）。
- 来源证据、知识回流、试验采用和 aibody 投影（阶段 4）。
- 观察面板、媒体绑定 UI、性能指标、类型/构建/E2E、全量隔离 verify（阶段 5）。
- 没有服务重启、版本升级、打包、合并或双推；分支和独立工作副本保留供后续实施。

下一步依照路线图形成阶段 2 的可执行计划，再接真实设计提交及用户控制，不重新请求批准已经确认的总体设计。
