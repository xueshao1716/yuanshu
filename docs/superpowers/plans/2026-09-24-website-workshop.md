# 网站工坊实施计划

**Goal:** 让用户直接编辑并交付网站，AI 只在明确范围内辅助。

**Architecture:** 新网站模块沿用现有鉴权、模型客户端和不可变版本存储模式。GrapesJS 懒加载画布，后台独立任务提供阶段记录。旧 M3E 项目独立保留。

**Tech Stack:** React、GrapesJS、Node、sanitize-html、PostCSS、LinkeDOM。

## 当前任务内顺序执行

- [x] 测试先行：`tests/unit/website-workshop.test.mjs` 覆盖安全文档、局部替换、隔离存储、阶段、取消和失败。先执行 `node --test tests/unit/website-workshop.test.mjs` 观察失败。
- [x] 文档/模板：`engine/website-document.mjs`、`engine/website-templates.mjs`；使用白名单静态 HTML、解析 CSS，保留响应式与 CSS 动画，拒绝脚本和危险链接。
- [x] 存储/执行：扩展 `createUiDesignStore(root, options)` 的目录与文档验证注入；新增 `website-service.mjs` 和 `website-routes.mjs`，注册 `/api/workshop-sites`，任务单次模型调用+最多一次结构修复，模型事实随版本保存。
- [x] 编辑前端：`components/website/` 分拆模板列表、编辑器、属性面板、任务状态；`lib/website-api.ts` 提供类型/API。替换 WorkshopUiBoard 主入口，旧实现移到 LegacyUiBoard。
- [x] 核心测试通过后，在隔离目录做浏览器验收：选中/文本/图片/链接/布局/撤销/版本/局部 AI/刷新/导出；不使用真实用户作品。
- [x] 执行 `npm --prefix frontend run typecheck`、全量测试、`npm --prefix frontend run build`、Impeccable detect。类型检查通过；全量测试 2047/2049 通过，剩余 2 项是既有未跟踪技能 `boundary-subject-vs-stance` 的描述契约失败；构建通过；Impeccable detector 返回空结果。另完成 17 项工坊/兼容性定向测试、语法检查和浏览器验收。最新全量测试使用普通 `npm test`，未显式隔离默认工作空间，不作为隔离测试证据。
- [x] 更新 CHANGELOG 和统一版本，构建/同步前端、重启并验证线上新入口，分步提交并验证两个远端提交一致。

全量测试当前为 2047/2049 通过；仅有既有的 `boundary-subject-vs-stance` 技能描述契约 2 项失败，与本次工坊无关。

## 发布记录（2026-09-24）

- 版本：`2.116.0`；实现提交：`ed68c9c0deffa0866d09cae8a55b54594f60b894`。
- GitHub 与 Gitee 的 `main` 均已推送，并通过分别读取远端提交确认与上述实现提交一致。
- 在线 `/api/health` 返回 `ok: true`；在线首页与 `frontend/dist/index.html` 一致；模板接口返回全幅影像、极简杂志、科技动态三套模板。
- `frontend/dist`、`public` 和 `app/dist` 首页内容哈希一致。本轮仅构建并同步网页资源，未重新制作桌面或手机安装包。
