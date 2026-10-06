# 元枢离线全量安装包

一个 exe 装好元枢全套服务。新电脑不需要联网，也不需要另装 Node / Python / Git / ffmpeg。

## 包里有什么
| 组件 | 说明 |
|---|---|
| 元枢 | 仓库里 git 已跟踪的源码（排除测试、安卓、桌面壳源码、文档）+ 生产依赖 |
| Node.js | 与构建机同版本的 `node.exe` + npm |
| pi / dsh 引擎 | `@earendil-works/pi-coding-agent`、`@deepseek-ai/dsh`，版本在 `build.mjs` 里钉死 |
| Python 3.12 | 嵌入版 + python-pptx / python-docx / openpyxl / xlrd / pandas / numpy / Pillow / PyMuPDF / requests / edge-tts / rembg |
| 抠图模型 | u2net.onnx（rembg 通过 `U2NET_HOME` 找到它） |
| ffmpeg / ffprobe | BtbN 共享库版 |
| Git Bash | PortableGit，元枢的命令工具用它 |
| 初始工作区 | `template/workspace`：小语的人格定义与 11 项性格基因基线、空白记忆骨架、「开始使用」说明 |

初始工作区**不含**任何个人数据：没有记忆内容、会话、密钥。人格模板由 `make-template.mjs` 从人格定义生成，只保留性格本体（名字、语气、价值观、边界、禁忌、基因基线），去掉来历与签名。

## 安装后发生什么
1. 程序装到 `%LOCALAPPDATA%\Programs\Yuanshu`，不需要管理员权限。
2. 注册计划任务 `yuanshu-watchdog`（登录自启，普通权限）；注册失败时退回「启动」文件夹快捷方式。
3. 服务首次启动时，在 `%USERPROFILE%\pi-workspace` 补齐模板里缺的文件，已有文件一律不动。升级或重装不会碰你的数据。
4. 开始菜单和桌面出现「元枢」。点它会先确认服务在跑，再打开浏览器并自动登录：令牌放在 URL 片段 `#t=`，不会发给服务器，读完立刻从地址栏抹掉。
5. 第一次打开会进入模型配置向导，填自己的 API Key。之后可在「系统 → 环境体检」看到各组件状态。

卸载：「设置 → 应用」或开始菜单「卸载元枢」。卸载时会问要不要删除工作区，默认保留。

## 自己构建
需要 Windows x64、Node ≥ 20、git、NSIS 3（装过 Tauri 的机器自带，见 `%LOCALAPPDATA%\tauri\NSIS`；或设 `MAKENSIS` 指向 makensis.exe）。构建机需要联网，装机不需要。

```bash
npm run deploy:frontend                 # 先构建前端
node installer/make-template.mjs <工作区>  # 可选：从你的人格定义重新生成模板
node installer/build.mjs                # 全部步骤，完成的步骤会缓存跳过
node installer/build.mjs --only=app,launcher,nsis   # 改了代码后只重打这几步
```

环境变量：
- `YUANSHU_BUILD_CACHE`：缓存与产物目录。
- `YUANSHU_NPM_REGISTRY` / `YUANSHU_PIP_INDEX`：镜像，默认 npmmirror / 阿里云。
- `YUANSHU_BUILD_PROXY`：GitHub、python.org 下载用的代理。

## 测试安装包
`安装包.exe /S /NOTASK /D=D:\tmp\yuanshu-test` 静默装到指定目录，不注册自启、不启动服务，适合在已经跑着元枢的开发机上检查文件。真正的验收要在一台没装过元枢的电脑上完整装一遍。

## 已知限制
- 安装包没有代码签名，首次运行 Windows 会提示「已保护你的电脑」，点「更多信息 → 仍要运行」。
- 端口固定 8787。
- 依赖里最深的文件相对路径接近 190 字符。默认安装目录没问题；自选安装目录请控制在 60 字符以内，否则会碰到 Windows 260 字符路径上限。
- 安装包约 1GB 级别，超过 GitHub 普通文件上限，发布走 Release 附件或网盘。
