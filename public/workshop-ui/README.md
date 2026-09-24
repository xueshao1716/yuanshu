# 界面工坊 · 官方 M3E Canvas

本目录是 [lnkiai/m3e-canvas](https://github.com/lnkiai/m3e-canvas)（MIT）的静态导出，不是元枢自绘壳。

- 上游提交：`d2bc92c`
- 构建：`NEXT_PUBLIC_BASE_PATH=/static/workshop-ui`
- 入口：`/static/workshop-ui/index.html?vanilla=1`
- 元枢壳：`yuanshu-shell.css` / `yuanshu-shell.js`（返回、桌面 0.85 / 手机 1 倍字号、元枢主题与模型）。
- 许可证：见同目录 `LICENSE`

升级：克隆上游 → 同样 base path 再 `npm run build` → 用 `out/` 覆盖本目录，并更新提交号。

## 元枢作品适配（2.115.21）

主入口是「创作 → 界面工坊」作品页。项目数据保存在工作区的 `workshop-out/ui-designs/`，版本只追加，选用旧版本只移动指针。旧匿名草稿沿用原 `m3e:doc`，不会自动迁移或覆盖。

`yuanshu-bootstrap.js` 必须在上游脚本之前加载，负责作品/版本命名空间、当前页模型和令牌。`yuanshu-project.js` 负责读取服务器版本、保存新版本和离页保护。URL 不携带令牌；跨域原生壳请在服务端网页登录后使用画布。

上游更新后执行 `node scripts/patch-workshop-ui.mjs`。它幂等修改三个草稿/锁键并挂载适配脚本，遇到未识别的上游结构会报错；不能绕过报错直接上线。保留 MIT LICENSE，并复测匿名草稿、两个作品隔离、保存返回与直接链接恢复。

补丁还在画布挂载后发出 `yuanshu-canvas-ready`，壳与保存控件收到后再改 DOM，避免破坏 Next/React 的初始页面匹配。草稿比较按字段排序并补默认 `dynamicColor:false`，不把编辑器正常化视为用户修改。

保存成功后，草稿归属新版本，画布自动切到新版本地址；原版本的本地草稿恢复为服务器原文。重新打开旧版不会误显示已经另存的新内容。

生成只读取该作品需求、参考文字和明确选择的基版；不自动抓参考 URL，不注入其他会话或人格记忆。结构校验只说明 JSON 可用，布局和视觉质量仍需画布预览确认。它是 M3E 界面草图工具，不等同于 Figma 文件编辑器或生产网站交付器。
