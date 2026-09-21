# 元枢 2.114.0 客户端打包核验

日期：2026-09-21。功能范围及完整测试见 [自进化机制验收](verification/evolution-2.114.0.md)。本次按用户要求重新打包 Windows 与 Android，并同步源码至 GitHub、Gitee。安装包沿用本机分发方式，不提交二进制文件或签名密钥到代码仓库。

## 前端与服务

- `frontend/dist` 与 `app/dist` 共 414 个文件，逐文件 SHA256 相同。
- `public` 中对应的 414 个文件全部一致，其独有的工坊资源和用户文件保留。
- 三处 `index.html` SHA256：`B9AE588792B32AA592499EA0D59706D05533E9D86C5C88719ECFC9B7F27ED4D0`。
- 主入口为 `index-PhMLyUho.js`。版本契约测试 12/12 通过。
- 本机健康接口与 Android 使用的公网首页均返回 200。打包期间未重启服务。
- 上一轮同版源码全量检查：1773 项通过，0 失败、0 跳过；类型检查、前端构建通过。本轮未再修改业务源码。

## Windows x64

- 安装包：`D:/pi-workspace/安装包/元枢_2.114.0_x64-setup.exe`。
- 大小：9,128,412 字节；SHA256：`E66F0D73FABF92FE6EB5E2D02E94A53F7F137323EE727BB585FD8D5246012B5C`。
- 本轮 NSIS 构建退出码为 0。构建原件、安装包目录与 `交付/元枢桌面客户端/` 副本哈希一致。
- 安装包和主程序 FileVersion / ProductVersion 均为 `2.114.0`；主程序 PE machine 为 `0x8664`（x64）。
- Authenticode 状态为 `NotSigned`，沿用现有未签名分发方式。

## Android arm64

- 安装包：`D:/pi-workspace/安装包/元枢-v2.114.0-arm64.apk`。
- 大小：16,493,075 字节；SHA256：`E71B3EB4DB01FAFF8842C4DD20819D466A8A77367BE9977353D355F98ACA534D`。
- 从签名后的 APK 读取：applicationId=`com.yuanshu.app`，versionName=`2.114.0`，versionCode=`2114000`，ABI=`arm64-v8a`，minSdk=`24`，targetSdk=`36`。
- apksigner 验证 v2/v3 签名有效；zipalign 16 KB 页面和 4 字节对齐检查通过。
- 沿用本机 Android Debug 证书，证书 SHA256 与 2.113.0 一致：`794311754e7420551ff205eef390facea93b051e40b0d58c220512a5ad7bfe33`。不是商店发布签名。
- APK 内原生库、本轮编译原件与 JNI 复制件 SHA256 一致：`8CFF1DB76E695EB622E7C678E3BAD191E9FD59A9BC0AFF152CED9703671DF39B`。
- Rust 编译成功后遇到本机符号链接权限限制，现有脚本自动复制库并调用 Gradle 兜底，最终退出码 0。
- Gradle 构建成功，168 项任务，28 项执行、140 项已是最新。DownloadBuffer 测试本轮实际执行，3/3 通过，0 失败、错误或跳过。
- 为避开 Android 工具的中文路径限制，使用 `tmp/yuanshu-2.114.0-signed.apk` 检查；该文件与交付副本哈希一致。

## 使用与边界

Windows 连接本机 `http://127.0.0.1:8787/`，Android 沿用 `https://pi.myxinyu.xin/`。客户端依赖现有后端，不包含独立离线后端。

本次完成包构建、内部版本、原生库、签名及交付完整性检查，未覆盖安装用户正在使用的客户端，未进行安装后 GUI 或手机真机功能测试。旧安装包保留，可供回退。
