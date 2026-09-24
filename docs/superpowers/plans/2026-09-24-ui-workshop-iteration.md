# 界面工坊作品迭代 Implementation Plan

> Inline execution in this session; preserve the existing checkout and unrelated untracked files.

**Goal:** 将已有 M3E 草图工具接到元枢作品与版本流程。
**Architecture:** 小型文件存储 + 后台生成服务 + React 作品页 + 可重复静态包适配。
**Tech Stack:** Node ESM、React/TypeScript、原 M3E 静态包。

## Tasks

- [x] 先写并运行 `tests/unit/ui-designs.test.mjs`：临时目录真实文件保存、越界 ID、版本回退、局部组替换、后台部分成功与模型事实。预期缺少模块而失败，随后实现 `engine/ui-design-store.mjs`、`ui-design-document.mjs`、`ui-design-service.mjs`。
- [x] 在 `server.mjs` 增加认证后的 projects GET/POST、project GET、versions POST、select POST、generate POST 路由；统一调用 `handleUiDesign`。
- [x] 为现行令牌和多画布隔离增加 `tests/unit/ui-workshop-shell.test.mjs`；先红后绿。`scripts/patch-workshop-ui.mjs` 仅机械替换经核对的 localStorage/锁键，挂载 bootstrap 与 project shell，重复运行不二次修改。
- [x] 用 `frontend/src/components/WorkshopUiBoard.tsx` 作为作品入口，拆 `UiDesignDetail.tsx`、`lib/ui-design-api.ts`；恢复可见错误与后台任务状态；移除 Workshop 自动跳转标记。
- [x] 精确模型选择的 cookie/body 优先级先测后修；真实模型验证后台两方向、局部替换不改其他组。
- [x] 临时目录隔离 `npm test`，`npx tsc --noEmit`，build，Impeccable detect；浏览器桌面1440/手机390检查及画布保存返回。全量两个已有技能格式失败详见验收文档。
- [x] 版本递增、前端快照同步、受控重启、健康与版本确认。

发布执行：只提交本轮文件，双推并校验远端提交一致；以实际提交和远端校验结果记录交付。

## Store/service contract

`createUiDesignStore(root)` exposes `create(input)`, `list()`, `get(id)`, `append(id,{doc,label,parentId,model})`, `select(id,versionId)`, `setRun(id,run)`.
`createUiDesignService({root,directChat,getModelList,defaultModel})` exposes store plus `start(id,{model,baseVersion,groupId,instruction})`; background completion is observable through `get(id).run`.
`validateDocument(doc)` rejects malformed or unsafe documents; `mergeGroup(base,groupId,answer)` enforces one-group editing.

Manual verification uses newly created 验收作品 only. No existing user canvas or generated deliverable is overwritten.
