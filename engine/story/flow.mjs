// engine/story-flow.mjs —— 流水线状态机（"现在能干什么、为什么不能"）
//
// 学自另一家产品（Pavo）的一处设计：它把 `flow` 下发给前端——
//
//   { current_step, allowed_actions, blocked_actions:[{action, reason_code, message}],
//     recommended_actions, failed_recovery_actions }
//
// 前端**不硬编码**"这一步该点亮哪个按钮"，而是照着服务端说的渲染；
// 被挡住的动作还带 reason_code + 人话，所以提示是「请确认脚本概要以供生成」，
// 而不是一个灰掉、点不动、也不说为什么的按钮。
//
// 元枢此前是反过来的：十几个按钮各自 disabled，用户得自己猜"我现在该干什么、
// 为什么合成成片是灰的"。这里把判断收到一处，纯函数、可单测。

// 四个阶段。顺序即"先干什么后干什么"，界面照它渲染胶囊。
export const FLOW_STEPS = Object.freeze([
  { id: 'script', label: '剧本大纲', hint: '梗概 · 人物设定 · 分场与段落' },
  { id: 'assets', label: '资产库', hint: '角色定妆照（场景/道具参考图）' },
  { id: 'shots', label: '分镜成片', hint: '每段生成画面或视频片段' },
  { id: 'film', label: '成片', hint: '按分镜顺序合成一支片子' },
]);

// 动作目录：界面只认这里给的 label，别在前端再抄一份（抄了就会两处不一致）。
export const FLOW_ACTIONS = Object.freeze({
  edit_outline: { label: '补梗概与人物设定', panel: 'bible' },
  generate_storyboard: { label: '一键分镜', panel: 'script' },
  next_beat: { label: '让 AI 构思下一段', panel: 'script' },
  generate_portrait: { label: '生成定妆照', panel: 'assets' },
  generate_asset_ref: { label: '生成场景/道具参考图', panel: 'assets' },
  generate_shot: { label: '生成当前段', panel: 'shots' },
  retry_failed: { label: '重试失败的段落', panel: 'shots' },
  check_running: { label: '查看进行中的任务', panel: 'shots' },
  localize_external: { label: '把外链产物拉到本地', panel: 'shots' },
  compose_film: { label: '合成成片', panel: 'film' },
});

const list = value => (Array.isArray(value) ? value : []);
const hasRef = item => Boolean(item?.refImage || item?.ref || item?.portrait || item?.anchor
  || (Array.isArray(item?.looks) && item.looks.some(l => l?.refImage)));
// 外链：http(s) 开头且不是本机/工作区的产物（工作区产物走 /api/ws/... 或 生成物/ 相对路径）
const EXTERNAL = /^https?:\/\/(?!127\.0\.0\.1|localhost)/i;
// ⚠️ 产物的 url **不在 run.url 上**，而在 `run.outputAssets[].url`（真机核过：
// 一个项目 14 条 run 里 `run.url` 全是 undefined，产物全在 outputAssets）。
// 只看 run.url 会把"已经出片的段落"算成"没有成品"，于是状态条一直催你重新生成。
const runUrls = run => [
  ...(Array.isArray(run?.outputAssets) ? run.outputAssets.map(a => a?.url || a?.path) : []),
  run?.url, run?.output?.url,
].filter(Boolean).map(String);
const hasArtifact = run => runUrls(run).length > 0;
// degraded = 片子到了但带降级说明（例如参考图没上送），**算有成品**；failed 才是没有。
const USABLE_STATUS = new Set(['succeeded', 'degraded']);
const usableRun = run => USABLE_STATUS.has(run?.status) && hasArtifact(run);

export function storyFlow(project) {
  const scenes = list(project?.scenes);
  const beats = scenes.flatMap(scene => list(scene?.beats));
  const runs = list(project?.runs).length ? list(project.runs) : scenes.flatMap(scene => list(scene?.outputs));
  const bible = project?.bible || {};
  const characters = list(bible.characters);
  const locations = list(bible.locations);
  const props = list(bible.props);

  const okRuns = runs.filter(usableRun);
  const failedRuns = runs.filter(r => r?.status === 'failed');
  const runningRuns = runs.filter(r => r?.status === 'running');
  const videoOk = okRuns.filter(r => r?.kind === 'video');
  const films = list(project?.films);

  const portraits = characters.filter(hasRef).length;
  const missingPortrait = characters.filter(c => !hasRef(c));
  const missingAssetRef = [...locations, ...props].filter(a => !hasRef(a));
  const beatsWithOutput = new Set(okRuns.map(r => r?.beatId).filter(Boolean));
  const beatsDone = beats.filter(b => beatsWithOutput.has(b.id)).length;
  const externalRuns = okRuns.filter(r => runUrls(r).some(u => EXTERNAL.test(u)));

  const progress = {
    beats: { total: beats.length, done: beatsDone, failed: failedRuns.length, running: runningRuns.length },
    assets: { characters: characters.length, portraits, locations: locations.length, props: props.length, missingRefs: missingAssetRef.length },
    clips: { usable: videoOk.length },
    films: films.length,
    external: externalRuns.length,
  };

  // 阶段完成度。**只用真实产物判断**，不看"用户点过什么"——
  // 点过不等于有东西，这条以前吃过亏（声称支持 seed 却从没生效）。
  const done = {
    script: beats.length > 0 && Boolean(String(project?.logline || '').trim()),
    assets: characters.length > 0 && missingPortrait.length === 0,
    shots: beats.length > 0 && beatsDone === beats.length,
    film: films.length > 0,
  };
  const steps = FLOW_STEPS.map(step => ({ ...step, done: Boolean(done[step.id]) }));
  const current = FLOW_STEPS.find(step => !done[step.id])?.id || 'done';

  const allowed = [];
  const blocked = [];
  const allow = id => allowed.push({ action: id, label: FLOW_ACTIONS[id].label, panel: FLOW_ACTIONS[id].panel });
  const block = (id, reason_code, message) => blocked.push({ action: id, label: FLOW_ACTIONS[id].label, panel: FLOW_ACTIONS[id].panel, reason_code, message });

  // ── 剧本大纲 ──
  if (!String(project?.logline || '').trim() || !characters.length) allow('edit_outline');
  if (beats.length === 0) {
    if (String(project?.logline || '').trim() || characters.length) allow('generate_storyboard');
    else block('generate_storyboard', 'no_outline', '还没有梗概或人物设定：先写一句这个故事讲什么，再让 AI 排分镜');
  } else {
    allow('generate_storyboard');
    allow('next_beat');
  }

  // ── 资产库 ──
  if (missingPortrait.length) allow('generate_portrait');
  else if (!characters.length) block('generate_portrait', 'no_characters', '还没有角色：先在设定里登记出场人物，再生成定妆照');
  else block('generate_portrait', 'assets_complete', `全部 ${characters.length} 个角色都有定妆照了，不用再生成`);
  if (missingAssetRef.length) allow('generate_asset_ref');
  else if (!locations.length && !props.length) block('generate_asset_ref', 'no_assets', '设定里还没有场景与道具');
  else block('generate_asset_ref', 'assets_complete', '场景与道具的参考图都齐了');

  // ── 分镜成片 ──
  if (beats.length) {
    if (beatsDone === beats.length) block('generate_shot', 'all_done', `${beats.length} 段都有成品了；要重做就在段落上单独重跑`);
    else allow('generate_shot');
  } else block('generate_shot', 'no_beats', '还没有段落：先一键分镜，或让 AI 构思下一段');
  if (failedRuns.length) allow('retry_failed');
  if (runningRuns.length) allow('check_running');
  if (externalRuns.length) allow('localize_external');

  // ── 成片 ──
  const videoBeats = beats.filter(b => b?.kind === 'video');
  if (!videoBeats.length) block('compose_film', 'no_video_beats', '还没有视频类型的段落：成片按视频片段拼接，先把段落切成视频');
  else if (videoOk.length < 2) block('compose_film', 'not_enough_clips', `可用视频片段只有 ${videoOk.length} 段，合成至少要 2 段`);
  else allow('compose_film');

  // 推荐顺序：先修失败，再看进行中，然后当前阶段的正事，最后是后面的阶段。
  const priority = ['retry_failed', 'check_running', 'edit_outline', 'generate_storyboard', 'generate_portrait', 'generate_asset_ref', 'generate_shot', 'localize_external', 'compose_film'];
  const allowedIds = new Set(allowed.map(a => a.action));
  const recommended = priority.filter(id => allowedIds.has(id)).slice(0, 3);

  const failedRecovery = failedRuns.length
    ? ['retry_failed', ...(runningRuns.length ? ['check_running'] : [])]
    : (runningRuns.length ? ['check_running'] : null);

  return {
    current_step: current,
    steps,
    progress,
    allowed_actions: allowed,
    blocked_actions: blocked,
    recommended_actions: recommended,
    failed_recovery_actions: failedRecovery,
    // 一句人话的总状态，界面直接显示（省得前端自己拼）
    headline: headlineOf(current, progress, failedRuns.length, runningRuns.length),
  };
}

function headlineOf(current, progress, failed, running) {
  // 两种都要说：只报"进行中"会把失败藏起来，而失败才是需要用户动手的那一半。
  if (running && failed) return `${failed} 段生成失败、${running} 个任务还在跑：先看结果，再决定重试哪段`;
  if (running) return `有 ${running} 个生成任务在进行中，先看它们的结果`;
  if (failed) return `有 ${failed} 段生成失败，先重试或改提示词`;
  const { beats, assets, clips } = progress;
  if (current === 'script') return beats.total ? '大纲还没齐：补梗概与人物设定' : '先给这个故事一个梗概，再让 AI 排分镜';
  if (current === 'assets') return `资产还缺 ${assets.characters - assets.portraits} 张定妆照${assets.missingRefs ? `、${assets.missingRefs} 个场景/道具参考图` : ''}`;
  if (current === 'shots') return `还有 ${beats.total - beats.done} 段没有成品（共 ${beats.total} 段）`;
  if (current === 'film') return `可用片段 ${clips.usable} 段，可以合成了`;
  return '这条片子已经走完整条流水线';
}
