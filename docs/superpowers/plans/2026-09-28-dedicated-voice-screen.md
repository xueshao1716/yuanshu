# 独立动态通话界面实施计划

> Goal: 默认进入纯动态通话画面，转写和任务按需内嵌查看，成果回原会话；消除麦克风授权前置等待。
> Date: 2026-09-28. User confirmed the interaction in this conversation.
> Execution: reuse the isolated mobile-realtime worktree; preserve existing dirty changes; no commit, push, backend restart or paid provider calls.

## 1. 音频启动与真实状态
- [x] 先在 chat-voice-capture/client 单元测试加入失败用例：resume 未完成时也立即申请麦克风；拒绝、取消和迟到授权释放资源；细分阶段和阶段耗时；迟到事件不能覆盖新通话。
- [x] audio.mjs 在同一用户动作栈申请媒体并唤醒音频，并发操作均接住拒绝。call.mjs 保留 phase，增加 stage、stageStartedAt、startedAt、readyAt、activity；playback 的开始/结束通知提供真实说话状态。
- [x] 运行 node --test tests/unit/chat-voice-capture.test.mjs tests/unit/chat-voice-client.test.mjs tests/unit/chat-voice-playback.test.mjs（以实际文件名为准）。

## 2. 稳定宿主与动态主画面
- [x] 更新 chat-voice-ui 源码契约并先看到失败。通话宿主移到 ChatArea 稳定 key 下，SendBox 只保留语音通话入口。
- [x] RealtimeCall 管生命周期；CallScreen/CallStage 拆分显示与动态光球，复用主题、图标和 CSS，不加依赖。
- [x] 主画面默认不显示旧聊天、转写或任务内容；记录按钮有待确认数量；切换记录不重连；结束仍可查看记录，返回聊天保留草稿和结果。
- [x] AppLayout 临时隐藏非通话导航与工具面板，不写持久偏好。处理键盘焦点、低高度、安全区、减少动态效果。

## 3. 浏览器回归与交付
- [x] 更新 fixture 和 shell E2E：授权/连接提示、拒绝/取消、三个视图切换不重连、初次会话创建不掉线、原会话成果持久、桌面/手机/低高度/减少动态效果。
- [x] npm run verify（隔离全量测试、类型检查、非线上构建）；运行相关浏览器测试；Impeccable detect；截图检查，不把无法目视的截图说成目视通过。
- [x] 审查需求及资源释放边界。仅同步本轮变更文件，先核对主仓库基线无漂移，再构建 frontend/dist；不清空旧 hash 资源。
- [x] 核对实际服务 bundle 与磁盘一致；交付通知；说明真实手机和真实付费供应商未实测。不自动提交或推送。
