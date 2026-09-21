# 元枢 2.113.0 安装包核验

日期：2026-09-21。功能范围见 [共享天团验收记录](verification-2.113.0-20260921.md)。已有工作区改动与旧版本安装包均保留。

## 前端快照

- 正式前端构建成功；第一次构建遇到 Windows 文件映射锁（os error 1224），重试成功。
- `npm run sync:frontend` 完成。frontend/dist 与 app/dist 共 604 个文件，逐文件内容一致。
- frontend/dist、app/dist、public 的 index.html SHA256 均为 `0B1CA79571E2CE083787939C6B4FF32B5034289C05FE2C0FD9A953A66C41B3DF`。
- 同步前备份：`D:/pi-workspace/.build-cache/package-backup-21130-2c7687fd94d44bd69b1199d1452a5335/`。
- 打包后的收尾修复只涉及服务端和测试，未改变客户端前端快照。

## Windows x64

- 交付：`D:/pi-workspace/安装包/元枢_2.113.0_x64-setup.exe`。
- 大小：10,501,736 字节；FileVersion / ProductVersion 均为 2.113.0。
- SHA256：`8D3040DE15A08A2010215AA51F4A2CC02D5BCB29F3DD3385DC188A64B84C3A70`。
- NSIS 构建成功，`app/tauri-build.exit` 为 0。构建原件、安装包目录和 `交付/元枢桌面客户端/` 副本哈希一致。
- Windows Authenticode 状态为 NotSigned；没有执行覆盖安装和安装后 GUI 验证。

## Android arm64

- 交付：`D:/pi-workspace/安装包/元枢-v2.113.0-arm64.apk`。
- 大小：18,397,715 字节。
- SHA256：`B905095DA8891C16F3398B1DBCF59762C15D8EB68DCA9A0745FAB2B14421C26D`。
- 从签名 APK 实际读取：applicationId=com.yuanshu.app，versionName=2.113.0，versionCode=2113000，ABI=arm64-v8a，minSdk=24，targetSdk=36。
- apksigner 验证 v2/v3 签名有效；zipalign 16 KB 页面及 4 字节对齐验证通过。
- 沿用本机 Android Debug 证书；证书 SHA256：`794311754e7420551ff205eef390facea93b051e40b0d58c220512a5ad7bfe33`。未配置商店发布签名。
- Windows 下 aapt 无法处理中文路径，使用内容哈希一致的 `tmp/yuanshu-2.113.0-signed.apk` 执行元数据和对齐核验。
- Rust release 编译成功；符号链接权限限制触发现有复制原生库和 Gradle 兜底流程，最终构建成功，`app/android-build.exit` 为 0。
- Gradle 168 项任务，28 执行、140 已是最新。DownloadBuffer 单元测试 3/3 通过，无失败、错误或跳过。
- 未执行本轮手机覆盖安装或真机功能测试。

## 连接范围

客户端依赖现有后端服务，不含独立离线后端。Windows 连接本机 8787，Android 沿用既有服务地址。网页已部署 2.113.0；包内版本与网页版本一致。
