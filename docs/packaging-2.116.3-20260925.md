# 元枢 2.116.3 发布与打包记录

日期：2026-09-25。本次交付工坊流式进度、检查点续做、模型事实分离和验收误判修复。不是全仓架构重写或全系统安全认证。

## 安装包

| 平台 | 文件 | 字节数 | SHA256 |
| --- | --- | ---: | --- |
| Windows x64 | `D:/pi-workspace/安装包/元枢_2.116.3_x64-setup.exe` | 9692884 | `46333357B9DBAD3DF67269828B87E39A6CAB150F8A6C9020091D6B3204C79250` |
| Android arm64 | `D:/pi-workspace/安装包/元枢-v2.116.3-arm64.apk` | 17328659 | `D5FEEE5358CD00C0BC27AF7B36E2E3D1E860ED58E64B553AF6FB3BC63E2055F4` |

- Windows：Rust release / NSIS 退出 0，编译约 4 分 14 秒；程序 FileVersion / ProductVersion 都是 2.116.3。构建、交付及安装包目录三份校验一致，未覆盖安装用户客户端。安装包未做 Authenticode 签名。
- Android：Rust release 通过（约 2 分 8 秒），Windows 符号链接权限限制触发既有复制库兜底；随后 Gradle BUILD SUCCESSFUL（约 2 分 11 秒），脚本退出 0。DownloadBufferTest 3/3，无失败、错误、跳过。
- APK 内部 applicationId=`com.yuanshu.app`，versionName=`2.116.3`，versionCode=`2116003`，ABI=`arm64-v8a`，minSdk=24，targetSdk=36。v2/v3 签名验证与 16 KB zipalign 检查通过。
- Android 沿用本机既有 Debug 证书，SHA256=`794311754e7420551ff205eef390facea93b051e40b0d58c220512a5ad7bfe33`，与上版记录一致；不是商店正式签名。aapt 首次读取中文路径失败，复制为英文路径并核对完整 SHA256 后成功读取元数据，不将首次失败隐藏。
- `adb devices` 无设备，未做真机覆盖安装、键盘、锁屏、下载验收。

## 验证与证据

- 升版后完整执行 `npm run verify`：2182/2182 测试通过，50 suites，0 失败/跳过/取消；单元测试约 141 秒，类型检查约 8 秒，隔离构建约 21 秒。打包后复核输入证据仍为 passed。
- 输入指纹：`9dc1176357cd637af2ca4b4ce49e16de1e4269be6e933404fa7c4820fb6f802c`。包含本机额外技能，远端干净检出测试数可能不同。
- Impeccable 检查 `WebsiteRunPanel.tsx` 输出空列表。现有 Vite 大 chunk、Toast 混合导入、Tauri identifier 和 Gradle/Java 弃用警告仍保留。
- 使用最终生产构建重跑 Chromium 工坊验收，桌面 1440×1050 / 手机 390×844 均通过进度、刷新、继续、不重跑已完成区块、候选预览、显式采用、无横向溢出；CSS 隔离检查通过，pageErrors=[]。截图保存但未做人工视觉审阅；不是 Android 真机测试。
- Step-5 原始真实任务和离线复查证据一同存档：约 143 秒续做下一段，约 6.5 秒完成选区修改；原验收误判报告保持失败、字节不改，修正验收器后离线复查通过。仅代表这一个真实场景。
- 独立审查工具两次未传入任务正文，均不计作独立审查通过；由主执行者复核变更和回归证据。
- 本机证据：`D:/pi-workspace/.build-cache/release-evidence-2.116.3-20260925/`，含验证日志、部署核验、浏览器与真实模型记录、Windows/Android 构建日志。

## 部署与文件保护

- 修改前逐文件哈希备份：`D:/pi-workspace/.build-cache/pre-release-2.116.3-20260925/`。
- 生产前端构建并同步，428 个文件在 `frontend/dist`、`app/dist`、`public` 完全一致；public 原有 46 个额外文件与备份一致。
- 基于入口可达性删除 100 个中间指纹资源，约 4.4 MB；当前和最近两个已发布入口所需资源保留。删除文件可从上述备份恢复。
- 重启前确认活动会话为空，并逐个读取工坊项目确认无运行任务，再执行正规重启脚本。没有强制取消用户任务。
- 重启后健康检查正常，版本接口为 2.116.3 / 2116003，8787 仅一个监听进程。
- 线上入口 SHA256=`62fe585f6216ee5198f031918a59e0900a8ba65eb483ae5237159d5042792607`，与磁盘一致；当前入口可达的 149 个 JS/CSS 全部 HTTP 200 且内容一致。
- 没有纳入 `server-new.mjs`、`server/`、本机新增技能、暂缓的跨系统方案或用户其他未提交文件。

## 范围边界

本次修复见 [Claude 建议逐项对账](claude-review-reconciliation-2026-09-25.md)。Responses 协议仍是整包返回；90 秒有效内容空闲、单次 5 分钟和整轮 15 分钟仍为安全边界，不承诺无限执行。全面服务拆分、全 API 类型化、OS 沙箱和凭据体系改造尚未完成，不能由本轮测试通过推导为完成。
