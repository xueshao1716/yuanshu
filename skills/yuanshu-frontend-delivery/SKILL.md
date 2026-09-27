---
name: yuanshu-frontend-delivery
description: 当用户修改元枢前端或 React UI，需要构建、验收、发版和重启时使用
---

# 元枢前端交付

把一次 UI 修改交付成可运行、可回滚、可复验的版本。适用于 `D:\pi-web` 的前端和服务联动改动。

## 工作顺序

1. 先检查 `git status --short`，保留用户已有修改；阅读实际 serving code、路由和组件，不以过期 README 推断行为。
2. 先跑与改动相关的定向测试，再运行项目验证：

```powershell
npm run verify
npm run build:frontend
npm run prune:dist -- --apply
npm run sync:frontend
```

3. UI 变更必须用真实浏览器检查 1440×900、390×844、320×568 和 844×390 横屏，至少确认无横向溢出、按钮可触达、资源实际加载、状态来自真实数据。
4. 需要发版时执行 `npm run version:bump -- patch`，补写 `CHANGELOG.md`，然后重新 build、prune、sync；版本号和变更内容必须一致。
5. 服务端变更或同步完成后用正规脚本重启：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\pi-web\scripts\restart-pi-web.ps1
```

6. 重启后验证 `/api/health` 和根页面都返回 200，再在前台刷新确认新资源已生效。

## 验收纪律

- 不把“构建成功”当成“浏览器可用”；移动端布局和真实点击路径必须实测。
- 不在长任务流式运行中重启；若必须重启，记录会中断并在重启后验证恢复。
- 不用裸 `npm test` 代替 `npm run verify`，除非明确需要且已隔离其工作区写入。
- 交付说明写清版本、验证命令、浏览器尺寸和未完成项；任何失败都如实保留。
