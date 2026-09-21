# 天团当前验收状态联动：实现与验证

日期：2026-09-20。位置：`D:/pi-web/.worktrees/verification-20260920`。仅隔离候选，未提交、合并或部署。

## 本批交付

- 新增 `engine/team-acceptance.mjs`：只读核对运行编号、提议编号、固定草稿/交付路径、提议内容和实际文件。
- 原始快照的 `delivery` 保留不动；GET `/api/team/run` 另返回 `acceptance`，前端独立展示“本快照的当前验收”。
- 区分 pending、accepted、rejected、applying、needs_recovery、target_changed、target_missing、record_missing、unknown。
- 只有提议状态 accepted、决定时间有效、草稿与提议一致、实际交付文件字节一致，才显示当前已通过且文件一致。
- 损坏、未知状态、错配、链接/硬链接、超限文件保守返回 unknown；响应不带提议正文。读操作不发布、不批准、不修改任何业务文件。
- 读取大小有上限：正文 2,000,000 字节，JSON 记录 16,000,000 字节（留出 JSON 转义和差异预览空间）。读取本身也有边界。

## 验证证据

- TDD：新模块及接线缺失时 22 项失败，见 `tmp/p1-acceptance-red.log`；随后实现。
- 定向：新模块 22 项 + 入口 UI/提示契约 4 项 = **26/26**，见 `tmp/p1-acceptance-focused.log`。
- 全量：**1678/1678，50 suites，0 失败/跳过**，约 101 秒，见 `tmp/p1-acceptance-full.log`。环境变量均指向独立临时工作区。
- TypeScript 类型检查和 Vite 构建退出 0，见 `tmp/p1-acceptance-build.log`；输出 `tmp/p1-acceptance-build-20260920`，不覆盖 frontend/dist 或 public。
- Impeccable detect 两个修改组件返回 `[]`；新模块/server 语法检查与 git diff --check 通过，后者仅既有 CRLF 提醒。
- 构建仍提示 Toast 混合静态/动态导入、部分包超过 500 kB；未在此批扩展修改。

## 隔离浏览器检查

使用 `tmp/acceptance-browser-server.mjs` + `tmp/acceptance-browser.tsx`，回环端口 5196，Vite 禁用全部代理，导入实际 TeamRunView/TeamRunStatus 与现有主题，接口由内存夹具提供，不启动业务 server 或 runner。

实际逐项确认：pending、accepted、rejected、needs_recovery、target_changed、target_missing、record_missing、unknown、历史快照与新启动并存、空数据、接口失败，预期文案均可见。

桌面和 360px 容器模式各检查一次；状态区实测 clientWidth/scrollWidth 均 328px，无横向溢出。浏览器 error 日志为空。这里只证明组件显示，不代表移动端原生包、完整工作台联调或真实用户验收端到端通过。后端状态变化另由真实 pending API + 临时文件测试覆盖。

## 复审和边界

- 本轮尝试独立复审及一次补发，工具两次均传递空正文，审查者明确未检查文件。因此**不宣称独立复审通过**；前批最后提示修订的独立复审也仍待补。主执行者已核对提示与清单字段，并再次跑入口提示契约。
- 文件核对是读取时的观察，不是数字签名、不可篡改来源证明或敌对本地并发写入下的 TOCTOU 防护。核对后文件仍可能变化；页面保留核对时间，约每 10 秒刷新。
- 未调用付费模型，未验证模型内容质量/真实视频生成/外部发布；未重启 8787 服务，不发外部通知、不写记忆。
- Impeccable 报告既有 `.impeccable/config.json` 的 `ignoreRules` / `_comment` 已不被当前版本读取；按技能要求仅记录，不顺带修复配置漂移。
- 后续先补独立复审，再安排空闲窗口下的候选服务联调/部署；统一 run-manager、取消/恢复、预算约束等仍属后续批次。
