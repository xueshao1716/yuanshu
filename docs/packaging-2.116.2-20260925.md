# 元枢 2.116.2 发布与打包记录

日期：2026-09-25。按既有授权集成运行修复、重启并打包 Windows / Android。内容质量、通道可用性和真机验收仍单独记录。

## 安装包

| 平台 | 文件 | 字节数 | SHA256 |
| --- | --- | ---: | --- |
| Windows x64 | `D:/pi-workspace/安装包/元枢_2.116.2_x64-setup.exe` | 9651609 | `CEC4B1A7708424800DC8CD8A487C78EE2CCD5D91408C19E5DF35573CD817EE97` |
| Android arm64 | `D:/pi-workspace/安装包/元枢-v2.116.2-arm64.apk` | 17328659 | `0AA9F40C86198FC1255D149C73557CDC7EFFE0A451C0F58F3A476DFDA29B78A1` |

- Windows：Rust release 与 NSIS 构建 exit 0；`yuanshu.exe` 的 FileVersion / ProductVersion 均为 2.116.2。构建产物与交付副本校验一致。安装包未做 Authenticode 签名，未覆盖安装用户客户端。
- Android：Rust 编译通过，遇到 Windows 符号链接权限限制后由既有脚本复制已编译库，再执行 Gradle 打包及单元测试。BUILD SUCCESSFUL、exit 0；DownloadBufferTest 3/3，无失败、错误或跳过。
- APK 内部 applicationId=`com.yuanshu.app`、versionName=`2.116.2`、versionCode=`2116002`、ABI=`arm64-v8a`、targetSdk=36。zipalign 16KB 页对齐检查、apksigner v2/v3 验证通过。
- Android 沿用既有 Debug 证书，SHA256=`794311754e7420551ff205eef390facea93b051e40b0d58c220512a5ad7bfe33`，与 2.115.19 包实查一致。此为签名兼容检查，不是实际覆盖安装验收，也不是商店正式签名。

## 集成验证

- 修复提交 `d3638f7e` 从隔离工作树快进合入 main，没有重置或暂存其他会话的文件。
- 隔离工作树：2130/2130 测试通过；集成主目录纳入额外 17 个本机技能后：2164/2164，50 suites，零失败、跳过、取消。主目录单元测试约 177 秒，类型检查约 11 秒，隔离构建约 7 秒。
- 主目录验证指纹：`3d8caa78791a374e08cd270568f1f54896d1da1bca74fdb5a935417a85a04440`；打包阶段再次核对仍为 passed。
- 集成后的 Chromium 工坊回归：1440×1050 和 390×844 均通过进度显示、刷新、失败恢复、已完成区块不重跑、候选预览、显式采用和无横向溢出；样式隔离通过，pageerror 为 0。这是浏览器自动检查，不是手工审美评审或 Android 真机测试。
- 已有 Vite 大 chunk / Toast 导入、Tauri identifier、Gradle / Java 弃用警告仍保留；未扩大到无关依赖升级。

## 上线与文件保护

- 发布前完整备份并逐文件校验 `frontend/dist`、`app/dist`、`public`，保存在 `D:/pi-workspace/.build-cache/pre-release-2.116.2-20260925/`。
- 生产前端构建通过。按当前入口和最近两个历史入口的可达性清理 111 个中间指纹文件，约 3.5 MB；可从上述备份恢复。当前和最近两个发布入口引用的资源保留。
- 同步后 429 个前端文件在 `frontend/dist`、`app/dist`、`public` 逐一 SHA256 一致；public 原有的 46 个额外文件保持不变。
- 等待正在运行的会话正常完成，再确认活动会话和工坊任务均为 0 后执行正规重启脚本；未取消用户任务。
- 重启后 `/api/health` 正常，`/api/frontend-version` 返回 appVersion=`2.116.2`、version=`2116002`，8787 为单一监听。首次版本查询在启动阶段超过 10 秒，复查 72 毫秒成功，不将该次超时隐去。
- 线上入口与磁盘 SHA256 均为 `3f9eeb56f4dafe9194824f95777bd0e111328a696a00fd2977dc06f637aa8581`；当前入口可达的 149 个 JS/CSS 资源全部 HTTP 200 且内容与磁盘一致。
- 全量日志、真实模型验收及浏览器证据保存在 `D:/pi-workspace/.build-cache/release-evidence-2.116.2-20260925/`。安装包、密钥、临时证据及用户其他未提交文件不进入源码提交。

## 已验证的修复与剩余限制

- 缓冲 JSON / 二进制 HTTP 请求在正文读完前持续响应超时和取消；新增 5 个回归测试先红后绿。流式读取生命周期仍由流式调用方管理，不宣称所有网络等待问题已解决。
- GLM 真实工坊生成、指定选区修改与导出通过；真实工具任务断开 SSE 后继续完成、重连补收 93 个事件，无重复或遗漏。细节见 [运行验收记录](runtime-acceptance-2026-09-25.md)。
- 初次验收的 Step-5 真实 anthropic-messages 请求返回 HTTP 403，没有静默替换模型；当次长任务验收未通过，原因未擅自归为余额或账号问题。其后复测结果见 [Step-5 与 Android 补充验收](runtime-followup-2026-09-25.md)，保留各次结果与范围。
- 未执行新的付费图片生成；未做手机真机安装、锁屏、后台保活验收。没有切换默认引擎、默认模型或改动人格。
- 服务器拆分和跨系统集成仍延期，未将本次发布变成额外架构改造。
