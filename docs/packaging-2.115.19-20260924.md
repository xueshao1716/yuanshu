# 元枢 2.115.19 发布与打包记录

日期：2026-09-24。本次按用户授权集成、重启、打包并执行 GitHub/Gitee 双推；内容质量限制继续保留，不把发布完成等同于全部能力验收通过。

## 安装包

| 平台 | 文件 | 字节数 | SHA256 |
| --- | --- | ---: | --- |
| Windows x64 | `D:/pi-workspace/安装包/元枢_2.115.19_x64-setup.exe` | 9220713 | `AB3AA6993C3ABA1C25B801A7ADCCC9A04C12F9850651727888753741E10DBD18` |
| Android arm64 | `D:/pi-workspace/安装包/元枢-v2.115.19-arm64.apk` | 16542227 | `AC54A87616828C9E97826742B19313CC846BF351092E5F45F80E7CCE500C7C7D` |

- Windows：Rust release 与 NSIS 构建 exit 0；可执行文件 ProductVersion/FileVersion 为 2.115.19。安装包未做 Authenticode 签名，未覆盖安装用户客户端。
- Android：Rust 编译完成后遇到 Windows 符号链接权限限制，构建脚本按既有机制复制已编译库，再运行 Gradle 打包和单元测试，BUILD SUCCESSFUL，exit 0。
- APK 内部 applicationId=`com.yuanshu.app`、versionName=`2.115.19`、versionCode=`2115019`，arm64-v8a，minSdk 24，targetSdk 36。zipalign 16KB 页对齐检查、apksigner v2/v3 验证通过。
- 沿用既有 Android Debug 证书，SHA256=`794311754e7420551ff205eef390facea93b051e40b0d58c220512a5ad7bfe33`，保持旧包签名兼容；不是商店正式签名。未做 Android 真机安装验收。
- 客户端服务地址沿用既有配置：Windows 本地 8787，Android `https://pi.myxinyu.xin/`。

## 验证与上线

- 隔离工作区全量 Node 测试：2026/2026、50 suites，零失败/跳过/取消，131.79 秒。
- 集成后版本契约和执行引擎身份测试 15/15，引擎目录测试 10/10。
- 前端类型检查及生产构建通过；9 个相关前端文件 Impeccable detect 结果为空。
- 真 React/Vite/Chromium 的桌面 1440px、手机 390px 回归 2/2，13.40 秒。这是浏览器行为验证，不代表 Tauri 真机验收。
- `frontend/dist`、`app/dist`、`public` 的 448 个文件逐一 SHA256 一致。发布前完整目录备份在 `D:/pi-workspace/.build-cache/pre-release-2.115.19-20260924-164023/`；仅裁剪不可达中间构建文件。
- 正规重启脚本成功。随后 `/api/health` 正常，`/api/frontend-version` 返回 appVersion 2.115.19 / version 2115019；入口 HTML 与新构建一致，8787 为单一监听。
- 已有 Vite/chunk/Toast、Tauri identifier、Gradle/Java 弃用警告未在本轮扩展处理。
- 测试日志保留在隔离工作树 `.verification/`，不提交临时文件、密钥或安装包。

## 引擎身份与保留限制

- 本轮系统上下文明确产品名、实际执行引擎及开轮文本模型；pi 适配器和元枢循环分别注入真实事实。元枢按会话工作目录读取人格，没有修改受保护人格文件。
- 上线查询的引擎配置仍是 primary=`pi`、secondary=`yuanshu`。本轮未更改默认主驾，不能把实际 pi 通道伪装成元枢循环。
- 天团真实样例中，自动复核虽通过，人工读稿仍发现砍单后镜头及预算分支矛盾。内容质量未验收通过，自动复核与人工验收分开表达。
- 真实媒体样例请求 1024×1536，返回 832×1248，比例正确但精确像素未达标。继续工具任务成功；尺寸不足明确记录，没有自动放大冒充原图或反复付费刷结果。
- 真实模型证据和内容反例见 [后台交付可靠性报告](superpowers/reports/2026-09-24-background-delivery-reliability.md)。
