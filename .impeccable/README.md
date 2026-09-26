# 检测规则说明

`config.json` 的检测规则放在 `detector` 下，顶层 `ignoreRules` 不会被当前版本读取。

保留既有四项规则的豁免理由：`public/css/*.css` 是主题库（synthwave/gold/quantum 等），渐变字与网格背景是主题设计的一部分；side-tab 用于 blockquote，layout-transition 用于侧栏动画。legacy 前端冻结。这些理由不代表免除人工检查，也不新增其他规则豁免。
