# Server.mjs 拆解计划 - 2026-09-25

## 目标

将 server.mjs（3550行）拆解为结构化的 server/ 目录，强制物理边界，防止再次膨胀。

## 拆解策略

### Phase 1: 骨架搭建（已完成）✅

```
server/
├── app.mjs                 # 应用总装配（路由表 + 中间件编排）
├── middleware/
│   ├── auth.mjs           # Bearer Token 鉴权
│   ├── cors.mjs           # CORS 处理
│   └── static.mjs         # 静态文件服务
└── routes/
    ├── chat.mjs           # POST /api/chat (SSE)
    ├── sessions.mjs       # /api/sessions/*
    ├── models.mjs         # /api/models/*
    ├── workspace.mjs      # /api/ws/*
    ├── media.mjs          # /api/image, /api/video, /api/media
    ├── stats.mjs          # /api/stats/*
    └── system.mjs         # /api/system/*
```

**产物**：
- `server-new.mjs` - 精简入口（~90行）
- `server/app.mjs` - 应用总装配
- `server/middleware/*.mjs` - 3个中间件
- `server/routes/*.mjs` - 7个路由组（骨架，待填充）

### Phase 2: 逐步迁移（进行中）

**迁移原则**：
1. **一次迁移一个路由组**，迁移完立刻测试
2. **保持 server.mjs 能运行**，新旧并存直到迁移完成
3. **engine/ 不动**，只是改变调用方式（从 server.mjs 集中调用 → 各路由按需调用）

**迁移顺序**（从简单到复杂）：

| 顺序 | 路由组 | 复杂度 | 优先级 | 状态 |
|-----|--------|--------|--------|------|
| 1 | system.mjs | 低 | 高 | 骨架已建 |
| 2 | stats.mjs | 低 | 中 | 骨架已建 |
| 3 | sessions.mjs | 中 | 高 | 骨架已建 |
| 4 | models.mjs | 中 | 高 | 骨架已建 |
| 5 | workspace.mjs | 高 | 中 | 骨架已建 |
| 6 | media.mjs | 高 | 中 | 骨架已建 |
| 7 | chat.mjs | 极高 | 极高 | 骨架已建 |

**迁移步骤**（以 system.mjs 为例）：

```bash
1. 在 server.mjs 找到所有 /api/system/* 的处理逻辑
2. 复制到 server/routes/system.mjs
3. 确保依赖的 engine 函数都在 engine 对象里
4. 测试：node server-new.mjs 启动，curl 验证
5. 确认无误后，从 server.mjs 删除对应代码
```

### Phase 3: 切换与清理

当所有路由迁移完成后：

```bash
1. 备份：mv server.mjs server-old.mjs.bak
2. 切换：mv server-new.mjs server.mjs
3. 全量测试：npm test
4. 验收：真实使用 1 天，无问题
5. 清理：删除 server-old.mjs.bak
```

## 强制边界规则

迁移完成后，执行以下规则：

### 红线 1：server.mjs 不得超过 150 行

```javascript
// 只允许包含：
// 1. import { CONFIG } from './config.mjs'
// 2. import { createApp } from './server/app.mjs'
// 3. import { loadEngine } from './server/engine-loader.mjs'
// 4. http.createServer() + server.listen()
// 5. 优雅关闭信号处理
```

### 红线 2：新增路由必须在 server/routes/ 下

任何新增 `/api/*` 端点，必须：
1. 在 `server/routes/` 下创建或修改文件
2. 在 `server/app.mjs` 的路由表注册
3. 不得直接写在 server.mjs

### 红线 3：engine/ 模块保持纯函数

engine/ 下的模块不应该：
- 直接操作 req/res
- 硬编码路由路径
- 包含 HTTP 处理逻辑

应该：
- 接收参数，返回结果
- 抛出错误由路由层处理
- 可独立测试

## 验证方式

### 自动验证

```bash
# 1. 行数检查
wc -l server.mjs | awk '$1 > 150 { exit 1 }'

# 2. 禁止在 server.mjs 直接写路由
grep -q "if (url.pathname ===" server.mjs && exit 1

# 3. 测试通过
npm test
```

### Git Hook

```bash
# .husky/pre-commit 增加：
if [ $(wc -l < server.mjs) -gt 150 ]; then
  echo "❌ server.mjs 超过 150 行，拒绝提交"
  exit 1
fi
```

## 当前进度

- [x] Phase 1: 骨架搭建
- [ ] Phase 2: 逐步迁移（0/7 路由组）
- [ ] Phase 3: 切换与清理

## 下一步行动

1. **立刻做**：迁移 system.mjs（最简单，验证流程）
2. **今天做**：迁移 sessions.mjs + models.mjs（核心功能）
3. **明天做**：迁移 chat.mjs（最复杂，需要完整测试）
4. **后天做**：切换 + 清理

## 风险控制

- 保持 server.mjs 和 server-new.mjs 并存，随时可回退
- 每迁移一个路由组立刻测试，不累积风险
- 不改 engine/ 逻辑，只改调用方式
- 有问题立刻回退到 server.mjs

---

**记录人**: 小语  
**日期**: 2026-09-25  
**状态**: Phase 1 完成，Phase 2 进行中
