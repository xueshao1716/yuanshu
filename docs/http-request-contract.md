# HTTP 请求收尾契约

适用范围：`server.mjs` 中央请求入口。不是所有路由错误体的统一迁移。

- 保留 `X-Request-Id`；中央捕获的错误体为 `{ error: string, requestId: string }`。
- 显式抛出的整数 400–499 保留状态和脱敏后的可操作原因；500–599 保留状态但不公开内部异常文本。其他状态统一为 500。
- 已发送响应头时不再次写 JSON、不追加虚构 SSE 事件：异常中断传输，现有前端恢复逻辑可观察到失败。已经结束的响应不重写。
- 静态服务的异步失败也进入中央错误边界。原有鉴权、缓存、CSP、正常 SSE 协议不变。
- 请求完成日志输出一行 JSON：`event=http_request`、`requestId`、`method`、`path`、`status`、`outcome`、`durationMs`。`outcome` 为 `finished` / `aborted` / `failed`；HTTP 状态另行保留。按响应 finish/close 记录一次，不以 handler return 当成完成。
- 不记录查询参数、请求体、请求头或异常正文；路径在静态处理器改写前捕获。沿用 `/static/` 不记录请求完成日志的约定。该日志不是覆盖所有敏感操作的安全审计。

回归：`tests/unit/http-lifecycle.test.mjs` 通过临时本地 HTTP 服务运行真实生产请求回调，不启动模型、不操作真实工作空间。
