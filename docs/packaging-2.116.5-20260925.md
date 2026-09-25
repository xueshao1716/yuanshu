# 元枢 2.116.5 安装包与补充验收

日期：2026-09-25。对应产品提交 `fd182f3f38aa88e4574ac11a0e2c9706b6ce9a7c`。
本轮完成会话素材保存与连续查看的回归、客户端打包和部署说明纠偏，不新增产品逻辑、不另升版本。

## Windows x64

- 安装包：`D:/pi-workspace/安装包/元枢_2.116.5_x64-setup.exe`，10812047 字节。
- SHA256：`F28E9B04B9B43B92D97A365323ADC14EEFA2F637E2B33D4CBA141B41E07A8876`。
- Rust release 编译约 5 分 26 秒，NSIS 构建脚本退出 0。
- 程序 FileVersion / ProductVersion 均为 `2.116.5`；构建目录、交付目录和安装包目录的文件 SHA256 一致。
- 安装包未做 Authenticode 签名，未执行覆盖安装。

## Android arm64

- 安装包：`D:/pi-workspace/安装包/元枢-v2.116.5-arm64.apk`，18590227 字节。
- SHA256：`1EC856862C9923ECEDEDA8D454FB98A9E3FFD31C64C17169D1329B4EA66198EF`，签名产物与交付副本一致。
- Rust release 通过；报告用时 6 分 57 秒，包含等待桌面构建释放共享缓存锁的时间。Windows 符号链接权限限制触发既有复制库兜底，源库与 JNI 副本哈希一致；Gradle 随后 BUILD SUCCESSFUL（2 分 22 秒），构建脚本退出 0。
- DownloadBufferTest 本轮 3/3 通过，无失败、错误、跳过；XML 时间戳 `2026-09-25T12:28:14.090Z`。
- 直接读取已签名 APK：applicationId=`com.yuanshu.app`，versionName=`2.116.5`，versionCode=`2116005`，ABI=`arm64-v8a`，minSdk=24，targetSdk=36。
- v2/v3 签名验证、16 KB 页及 4 字节 zipalign 检查通过。沿用本机 Debug 证书，SHA256=`794311754e7420551ff205eef390facea93b051e40b0d58c220512a5ad7bfe33`；直接读取旧版 2.116.3 APK 并核对相同，不是商店正式签名。
- 没有连接手机，没有执行真机覆盖安装。版本号递增与证书一致仅是覆盖升级的必要检查，不等于实际安装验收。

## 回归证据

- 本轮 `npm run verify`：2202/2202 测试通过，50 suites，0 失败、跳过、取消；类型检查、隔离构建通过。
- 单元测试约 171 秒，类型检查约 10 秒，构建约 7 秒。输入指纹：`d91160a3ec76ca113be8806ca0ef458848ca0b1e8dbfdc575d045172dcccecab`。
- 保存与素材库四组定向测试：15/15 通过，覆盖原生桥分块传输、失败清理、页面离开取消、保存完成状态、中文文件名和会话隔离。
- `node scripts/verify-chat-media.mjs` 再次通过：真实 Chromium 桌面/手机布局，图片和视频下载文件名与字节一致，切换、边界、历史记录、错误、取消均通过。
- 最新浏览器证据：`C:/Users/XUEXIA~1/AppData/Local/Temp/yuanshu-chat-media-ouVvsV`。触摸为合成事件，不是手机实机验收；截图未做人工视觉审阅。
- 证据归档：`D:/pi-workspace/.build-cache/release-evidence-2.116.5-20260925/`。

## 部署与边界

- 本轮只做打包与文档更正，无需再次重启。健康接口返回 `ok: true`，8787 只有一个监听进程（检查时 PID 21840）。
- `frontend/dist`、`public`、`app/dist` 的入口 SHA256 一致：`177A5D98318292CA337EC5B3609D837651F7E0C982AD311957A97516E37AE58F`。
- 根据 `app/src-tauri/src/lib.rs`：桌面壳加载本机 8787，手机壳加载 `https://pi.myxinyu.xin/`。已更正 AGENTS 中“手机只使用打包快照”的过时说明。线上前端可重新加载更新；原生桥、权限或客户端版本变化仍需更新安装包。
- `adb devices -l` 无设备。Android 系统文件选择器、实际写盘、真机滑动与覆盖安装仍需连接手机验证，不以浏览器和单元测试替代。
- 保留既有大 chunk、Tauri identifier 等构建警告；不将本轮通过等同于所有历史架构、安全或模型通道问题已完成。
