# 天团仓库入口迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. 本批不提交、不推送、不部署、不通知、不写记忆。

**Goal:** 让候选服务启动仓库内 runner，配置与快照使用同一工作区，拒绝重复启动并如实显示启动状态和草稿状态。

**Architecture:** 这是 P1 的入口切片，不替换 run-manager、不另建通用执行引擎。保留旧 team-run.json 读取；现有外部进程锁兼容检查，新增排他启动锁收紧并发。暂不宣称恢复、取消、事件重放与预算已接入。

**Tech Stack:** Node ESM、node:test、React、现有 reviewStoragePath/reviewAtomicWrite。

## Task 1：配置与仓库资源（已实现并验证）

- [ ] 新建 scripts/team-runtime-config.mjs：loadTeamRuntimeConfig({env, repoRoot, readTokenFile}) 返回 wsRoot/teamRoot/baseUrl/token。新环境变量优先旧环境变量；仅允许 HTTP loopback，拒绝userinfo/path/query/hash，token来自环境或仓库.token，不生成。
- [ ] tests/unit/team-runtime-config.test.mjs 先红后绿：注入读取器，临时目录，不读取真实凭据。核心断言：`assert.throws(() => loadTeamRuntimeConfig({env:{YUANSHU_TEAM_BASE_URL:'https://example.com',YUANSHU_TOKEN:'fixture'},repoRoot}), /本机/)`。
- [ ] 新建 scripts/team-video-profile.mjs：仅当前实际5角色、12项视频清单；V12检查草稿完整，不要求提前正式交付。
- [ ] runner移除D盘硬编码和外部spec读取，使用固定VIDEO profile；快照使用链接保护与原子写，runId保存到快照。只语法检查，不直接执行runner。

## Task 2：可测试启动边界（已实现并验证）

- [ ] 新建 engine/team-launch.mjs：createTeamLauncher({wsRoot,repoRoot,port,token,spawnProcess})，start(task)返回HTTP风格status/body；固定仓库脚本、配置通过env传递，windowsHide且不使用shell。
- [ ] 通过wx排他锁覆盖检查和spawn，检测旧锁PID仍存活时不按20分钟年龄强行重启；权限不足/损坏锁拒绝猜测释放。失败保留可诊断状态，不把spawn请求等同成功。
- [ ] tests/unit/team-launch.test.mjs：使用临时目录和受控子进程事件，断言重复start只spawn一次、spawn错误500、存活旧锁409、坏锁409、路径链接拒绝、token不进参数/响应、仓库固定入口。先红后绿。
- [ ] server.mjs只替换POST天团启动段，GET附加独立launcher状态，不把旧快照当新运行结果。

## Task 3：前端及验证（实现与自动验证完成；最终提示复审待补）

- [ ] TeamRunView显示独立启动状态、流程版本和草稿投递状态，未知模式不称真实演练；去掉旧外部脚本启动提示。
- [ ] 源码契约先红后绿：`assert.ok(src.includes('launch?.status'))`；状态与交付不混为一谈。
- [ ] 定向测试、全量隔离测试、tsc/build到新的tmp目录、Impeccable、syntax、diff检查。
- [ ] 独立复审本批修改；保存证据及未实现边界。浏览器/真实模型/部署验证未运行则明确不宣称。

## 执行记录（2026-09-20）

- [x] Task 1 全部条目完成：配置注入、回环地址校验、本地五角色与十二项清单、runner 原子写快照。
- [x] Task 2 全部条目完成：独占启动、旧锁兼容、失败状态、固定入口及 server 接线；另补真实无模型子进程与跨实例状态回归。
- [x] Task 3 页面实现、源码契约、31 项定向测试、1656 项全量测试、类型/构建、Impeccable、语法与 diff 检查完成。
- [x] 入口切片独立规格/质量复审完成，无阻断项；审查发现的提示字段矛盾随后已修正并验证。
- [ ] 最后提示修订的二次独立复审：工具正文传递异常，尚未完成。浏览器/模型/部署也未执行。
- [x] 证据和边界已保存到 `2026-09-20-p1-entry-validation.md`；保持隔离工作区，不合并、不提交、不部署。

上方任务条目保留原始清单以便核对，以上执行记录为当前进度。
