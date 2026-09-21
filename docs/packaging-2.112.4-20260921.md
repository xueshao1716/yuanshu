# 元枢 2.112.4 安装包验证记录

日期：2026-09-21。基于当前工作区打包，保留已有源码改动。网页功能验收见 [verification-2.112.4-20260921.md](verification-2.112.4-20260921.md)。

## 前端快照

- 执行仓库 `npm run sync:frontend`，将 frontend/dist 同步到 public 和 app/dist。
- frontend/dist 与 app/dist 的 509 个文件逐一校验，无差异。
- 三处 index.html SHA256 相同：`add02171e815d045b9472688b03c023bc82e88b6480e90c1149287d1f79d1b6f`。
- 同步前备份：`D:/pi-workspace/.build-cache/package-backup-21124-e5ac4662517e4de8b811b1c158631c40/`。

## Windows x64

- 交付：`D:/pi-workspace/安装包/元枢_2.112.4_x64-setup.exe`；构建脚本另存一份到 `D:/pi-workspace/交付/元枢桌面客户端/`。
- 文件大小：9,788,123 字节。
- SHA256：`35b1ce4c829e2548008bb682eb47d771d065d62a6512765933a9d7614a8b2587`。
- 主程序和 NSIS 安装程序的 FileVersion / ProductVersion 均为 `2.112.4`，ProductName 为元枢；主程序 PE machine=`0x8664`，确认 x64。
- `tauri build --bundles nsis --ci` 成功，`tauri-build.exit=0`，生成时间 2026-09-21 15:45:51。
- 构建输出与两个交付副本 SHA256 一致。
- 主程序大小 18,097,664 字节，SHA256：`d78528173967a026ffb5871fd82b83c4f2d536c4408cff67a24913d4f9a70329`。
- Windows 安装程序未配置 Authenticode 代码签名（NotSigned）。未执行覆盖安装或安装后 GUI 测试。
- 日志：`app/tauri-build-stderr.log`、`app/tauri-build.log`。

## Android arm64

- 交付：`D:/pi-workspace/安装包/元枢-v2.112.4-arm64.apk`。
- 文件大小：17,443,347 字节。
- SHA256：`1cbb4cbd2e2c6e9703db07d46ea7f4a17ca24b223884b53d53c554a624ab9341`。
- 从签名后的 APK 读取：applicationId=`com.yuanshu.app`，versionName=`2.112.4`，versionCode=`2112004`，ABI=`arm64-v8a`，minSdk=`24`，targetSdk=`36`。
- apksigner 验证通过，v2/v3 签名有效；zipalign 16 KB 页面及 4 字节对齐验证通过。
- 与既有 `元枢-v2.109.3-arm64.apk` 的签名证书 SHA256 一致：`794311754e7420551ff205eef390facea93b051e40b0d58c220512a5ad7bfe33`。
- 沿用本机 Android Debug 证书，适用于既有本地安装链路；未配置商店发布签名。
- APK 内原生库与本次编译/组装的 arm64 库 SHA256 一致：`29af9746509bed69c282f02e88cd84b8742f6e09fc57f76b1179a69679eb4e65`。
- Rust release 编译成功。Windows 符号链接创建受限后，仓库现有脚本自动复制原生库并调用 Gradle；核对复制前后文件哈希一致。
- Gradle `assembleArm64Release testArm64ReleaseUnitTest -x rustBuildArm64Release` 成功，168 项任务（30 执行、138 已是最新）；3 项 DownloadBuffer 测试通过，无失败、错误或跳过。
- `android-build.exit` 为本轮生成的 0，时间 2026-09-21 15:41:23。
- 日志：`app/android-build-024-stderr.log`、`app/android-gradle-024.log`；测试 XML：`app/src-tauri/gen/android/app/build/test-results/testArm64ReleaseUnitTest/TEST-com.yuanshu.app.DownloadBufferTest.xml`。

## 运行范围

- 桌面客户端连接 `http://127.0.0.1:8787/`；Android 客户端连接 `https://pi.myxinyu.xin/`。客户端依赖现有服务，不包含独立离线后端。
- 本轮检查本机健康接口、公网首页均返回 200，本机前端版本接口为 2.112.4 / 2112004。
- 没有连接 ADB 设备，未进行本轮手机覆盖安装或真机功能测试。
- 本轮不覆盖安装正在使用的客户端，不重启服务，不推送仓库，不发送外部通知。
