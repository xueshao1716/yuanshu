---
name: misleading-error-debugging
description: 当需要排障（服务起不来、请求 400）时用：错误信息会撒谎，先定位真实报错者与覆盖层再改代码
---

# 排障守则：错误信息会撒谎

服务起不来/请求 400 时，按以下顺序排查，不要先怀疑代码。

## 核心原则

1. **报错的服务不是报错的服务**。错误信息指向的方向常常是错的：
   - 有 fallback/重试层的系统（如 LLM gateway、反向代理），未知配置会**静默降级**，报出来的是兜底方的错误。例：hermes 未知 provider 请求全部静默 fallback 到 OpenRouter，报的是 OpenRouter 的 400，真实错误被吞。
   - 先问一句：“这个错误是谁报的、为什么执行流会走到它？”
2. **“进程活着”≠“服务可用”**。健康检查必须探到业务的活性层（如 `/ready` 端点、真实请求），而不是宿主存在层（tasklist/进程在）。僵死进程会永远通过进程级检查。守护脚本应三分支：死→拉起 / 僵→杀重启 / 健→skip。

## 固定排查顺序

1. **先跑前台看真实报错**。服务起不来，第一反应是前台直接跑（如 `node server.mjs`），一秒看到 ERR_MODULE_NOT_FOUND 之类的真实错误，而不是猜配置。
2. **查环境变量覆盖层**。npm/子工具的解析异常，先 `npm config get prefix` + 查用户级环境变量（如 `NPM_CONFIG_PREFIX`、`ANTHROPIC_BASE_URL`），再怀疑代码。环境变量是最隐蔽的覆盖层，能悄悄覆盖一切配置文件。
3. **找日志和 secrets 的真实位置**。工具的日志可能不记 LLM/上游错误（日志黑盒），secrets 可能在非直觉路径（如 `AppData/Local/xxx/.env` 而非 `~/.xxx/.env`）。配置形态错但语义对的问题（dict 写成 list）最阴险，逐字段比对可工作的参考配置。
4. **修实现前先读测试全文**，判断是测试错还是实现欠债。没跑过就 commit 的新测试，可能正指着未实现的行为——这时该补实现，不是改测试。

## 批次收尾检查（防债）

- 双推检查同时看 `git log origin..main` **和** `git status`：做完没 commit 的工作区和未跟踪的新测试文件也会成为隐性炸弹。
- 升级工具链时，PATH 里 vendor node、用户级 npm prefix、Program Files 权限是三个常见拦路虎；可用 vendor 自带 npm 本地安装绕过全局权限。