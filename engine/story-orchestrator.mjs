import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProject, listProjects, readProject, writeProject, validateProject, mergeBeatContext, trashProject } from './story-store.mjs';
import { compileStoryPrompt, buildPortraitPrompt, buildAssetPrompt } from './story-prompts.mjs';
import { compileShotPrompt, shotFieldsFromBeat, assetRefsForShot, splitRefs, resolveStyle } from './story-shot-prompt.mjs';
import { storyFlow } from './story-flow.mjs';
import { syncLines, computeTimeline } from './story-lines.mjs';
import { createImageAdapter, createNovelAdapter, createVideoAdapter } from './story-adapters.mjs';
import { buildStoryAssistPrompt, parseStoryAssist, buildStoryboardPrompt, parseStoryboard, buildAdaptPrompt, parseAdapt, extractJsonObjects } from './story-assist.mjs';
// 台词与深度构思的"手艺"：机检规则 + 提示词 + 宽容解析（见 story-craft.mjs 开头的研究结论）
import { dialogueAudit, auditEngine, buildDialogueDoctorPrompt, parseDialogueDoctor, buildStoryEnginePrompt, parseStoryEngine, CRAFT_NOTES } from './story-craft.mjs';
import { parseDialogueLines } from './story-screenplay.mjs';
import { lintStoryProject } from './story-lint.mjs';
import { concatClips, filmPlan, filmPlanWithDurations, localPathFromArtifactUrl } from './story-film.mjs';
import { materializeMedia } from './media-inline.mjs';
// seed 的合法区间由上游接口决定（Agnes 图像是 -1..999），权威定义在 media-api 里——
// 编排层不许自己猜一个范围：上一版就是自己掷了个 2^31 的数，把画面生成全线打挂。
import { SEED_RANGE, clampSeed } from './media-api.mjs';
import { listRecipes, saveRecipe, deleteRecipe, importRecipes, exportRecipes, normalizeRefStrategy } from './story-recipes.mjs';
import { buildStorySoFar, contextBudget } from './story-context.mjs';
import { renderScript, scriptStats, SCRIPT_FORMATS } from './story-screenplay.mjs';
import { runRoleplay, normalizePlayground } from './story-playground.mjs';
import { normalizeEpisodes, createEpisode, groupScenesByEpisode, episodeStats, assignSceneToEpisode, removeEpisode, renumberEpisodes } from './story-episodes.mjs';
// 创作方法包（Skill）：程序性知识，跨项目复用。见 engine/story-methods.mjs 开头的研究结论。
import { listMethods, methodOf, saveMethod, deleteMethod, captureFromProject, methodBrief, reasoningBudget } from './story-methods.mjs';
import { resolveColorCard } from './color-cards.mjs';
import { json } from './http-utils.mjs';

const makeId = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();
const fileExists = async file => { try { await fsp.stat(file); return true; } catch { return false; } };
const BIBLE_ASSET_KEYS = { characters: 'character', locations: 'location', props: 'prop', wardrobe: 'wardrobe' };

// ── 把"还挂在外站"的地址搞到本地（docs/NAMING.md 第三节的本地化契约）──
// 外站给的是几小时到几天就失效的临时链接，所以凡是能下载的产物**必须先落到本地**。
// 三种地方会漏：运行产出、参考图（定妆照/场景/道具）、补下载入口——它们共用这一段判定，
// 免得三处各写一遍、各漏一种。
// 返回 { ok, url, from?, alreadyLocal? , reason? }；失败一定带 reason（不许含糊）。
async function pullToLocal(url, { type = 'image', prompt = '', root, saveArtifact } = {}) {
  const raw = String(url || '');
  if (!raw) return { ok: false, reason: '这个条目还没有产物' };
  const file = localPathFromArtifactUrl(raw, root);
  if (file && (await fileExists(file))) return { ok: true, alreadyLocal: true, url: raw };
  if (!/^(https?:|data:)/i.test(raw)) return { ok: false, reason: '既不是本地文件也不是可下载的外链' };
  if (typeof saveArtifact !== 'function') return { ok: false, reason: '落盘实现未接入（下载不到本地）' };
  const saved = await saveArtifact({ type, url: raw, prompt });
  if (!saved?.local) return { ok: false, reason: saved?.reason || '下载失败' };
  const localFile = localPathFromArtifactUrl(saved.url, root);
  if (!localFile || !(await fileExists(localFile))) return { ok: false, reason: '下载成功但本地文件找不到（落盘路径解析失败）' };
  return { ok: true, url: saved.url, from: raw };
}

// 视频轮询窗口（多长之后前端**不再自动等**）。可配：`STORY_VIDEO_POLL_MS`，默认 10 分钟。
// 注意它**不是失败判据**：超窗只是"不再自动等"，任务在上游是死是活要靠「查一次」问出来。
// 以前的 180 秒硬超时是把"还没好"直接说成"超时失败"，那是两件事。
const DEFAULT_VIDEO_POLL_MS = 10 * 60 * 1000;
export function videoPollWindowMs(env = process.env) {
  const raw = Number(env?.STORY_VIDEO_POLL_MS);
  return Number.isFinite(raw) && raw >= 5000 ? raw : DEFAULT_VIDEO_POLL_MS;
}
function waitedMs(run, clock) {
  const from = Date.parse(run?.queuedAt || run?.createdAt || '');
  const now = Date.parse((clock.now || nowIso)());
  return Number.isFinite(from) && Number.isFinite(now) ? Math.max(0, now - from) : 0;
}

export function negotiateCapabilities(required = {}, supported = {}) {
  const degradation = [];
  const labels = { reference: '参考资产', keyframe: '关键帧', seed: '固定 seed' };
  for (const key of ['reference', 'keyframe', 'seed']) {
    if (required[key] && !supported[key]) degradation.push(`${key}: 当前模型不支持${labels[key]}`);
  }
  return { supported: { reference: !!supported.reference, keyframe: !!supported.keyframe, seed: !!supported.seed }, degradation };
}

export function capabilitiesFor(kind, model) {
  const required = { reference: kind !== 'novel', keyframe: kind === 'video', seed: kind !== 'novel' };
  return negotiateCapabilities(required, model?.capabilities || {});
}

export function createGenerationRun(input, clock = {}) {
  const now = (clock.now || nowIso)();
  const kind = ['novel', 'image', 'video'].includes(input?.kind) ? input.kind : 'image';
  const capabilities = capabilitiesFor(kind, input?.model);
  return {
    id: (clock.id || makeId)(),
    projectId: input.projectId,
    sceneId: input.sceneId,
    beatId: input.beatId,
    kind,
    model: { provider: String(input?.model?.provider || ''), id: String(input?.model?.id || '') },
    capabilities: capabilities.supported,
    params: input?.params && typeof input.params === 'object' ? input.params : {},
    seed: Number.isFinite(input?.seed) ? input.seed : undefined,
    inputAssets: Array.isArray(input?.inputAssets) ? input.inputAssets : [],
    outputAssets: [],
    status: 'queued',
    degradation: capabilities.degradation.length ? capabilities.degradation : undefined,
    parentRunId: input?.parentRunId || undefined,
    // 段号在**生成时刻**定下来。作品列表原先按当前分镜顺序现算，一旦重排分镜，
    // 旧产物卡上的"第 N 段"就跟着变——产物是历史，不该被后来的重排改写。
    beatNo: Number.isFinite(input?.beatNo) ? input.beatNo : undefined,
    sceneTitle: input?.sceneTitle ? String(input.sceneTitle) : undefined,
    createdAt: now,
  };
}

export function appendRun(scene, run) {
  if (!Array.isArray(scene.outputs)) scene.outputs = [];
  scene.outputs.push(run);
  scene.activeRunId = run.id;
  return scene;
}

// 出场角色 / 场景 / 道具 → 参考图 URL。规则刻意保持可解释，不做玄学推断。
//
// **关键：判定要基于"这一段自己的文本"，而不是编译后的整份提示词。**
// 2026-09-15 踩到：compileStoryPrompt 会把整个 bible（角色/场景/道具全列）写进提示词，
// 于是"名字出现在提示词里"对**每一个**条目都成立——规则直接退化，一段视频会把所有参考图
// 全挂上（每张内联成 base64 都是 MB 级，既烧钱又给模型塞噪音）。
// 现在传入的是 beat.prompt + dialogue + action，只有这一段真正提到谁才挂谁。
// 1) 名字出现 → 视为出场；
// 2) 角色一个都没匹配上时，退回首张有定妆照的角色（通常是主角）；
// 3) 顺序：角色（人物一致性最要紧）→ 场景 → 道具。
export function pickReferenceImages(project, sourceText, limit = 4) {
  const text = String(sourceText || '');
  // 角色可能有多张形象（基础形象/战斗装束…）：**这一段提到哪张就挂哪张**，
  // 没提到就挂基础形象。只认 refImage 的老逻辑在"换装段落"上必然挂错图。
  const lookOf = (item) => {
    const looks = Array.isArray(item?.looks) ? item.looks.filter(l => l?.refImage && l?.name) : [];
    return looks.find(l => text.includes(String(l.name))) || null;
  };
  const hasRef = x => x && (x.refImage || x.ref || lookOf(x));
  const refOf = x => String(lookOf(x)?.refImage || x.refImage || x.ref);
  const bible = project?.bible || {};
  const mentioned = list => (list || []).filter(x => hasRef(x) && x.name && text.includes(String(x.name)));
  const chars = mentioned(bible.characters);
  const ordered = [
    ...(chars.length ? chars : (bible.characters || []).filter(hasRef).slice(0, 1)),
    ...mentioned(bible.locations),
    ...mentioned(bible.props),
  ];
  const seen = new Set();
  const out = [];
  for (const item of ordered) {
    const url = refOf(item);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= limit) break;
  }
  return out;
}

// 判定参考图要用的"这一段自己的文本"。**不要**用编译后的提示词（它含整个 bible）。
export function beatReferenceText(beat) {
  return [beat?.prompt, beat?.dialogue, beat?.action].filter(Boolean).map(String).join('\n');
}

function findScene(project, id) { return (project.scenes || []).find(s => s.id === id); }
function findBeat(scene, id) { return (scene?.beats || []).find(b => b.id === id); }

const BIBLE_LISTS = { characters: 'char', locations: 'loc', props: 'prop', wardrobe: 'ward' };

// 把分镜登记的人物/场景并进设定：**只补空缺，不改写已登记的实体**（与智能填充同一约定）。
// 名字相同（忽略大小写与空白）就算同一个，否则每次分镜都会堆出一串重复角色。
export function mergeStoryboardBible(bible, incoming) {
  const base = { characters: [], locations: [], props: [], wardrobe: [], style: {}, rules: [], ...(bible || {}) };
  const norm = value => String(value || '').trim().toLowerCase();
  const next = { ...base };
  for (const [key, prefix] of Object.entries(BIBLE_LISTS)) {
    const existing = Array.isArray(base[key]) ? [...base[key]] : [];
    const seen = new Set(existing.map(item => norm(item?.name || item?.text)));
    for (const item of (Array.isArray(incoming?.[key]) ? incoming[key] : [])) {
      const name = norm(item?.name || item?.text);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      existing.push({ id: `${prefix}-${makeId()}`, ...item });
    }
    next[key] = existing;
  }
  // 已有风格优先：分镜不该把人工调好的视觉基调冲掉。
  next.style = { ...(incoming?.style || {}), ...(base.style || {}) };
  const rules = Array.isArray(base.rules) ? [...base.rules] : [];
  const ruleTexts = new Set(rules.map(r => norm(r?.text)));
  for (const rule of (Array.isArray(incoming?.rules) ? incoming.rules : [])) {
    if (!norm(rule?.text) || ruleTexts.has(norm(rule.text))) continue;
    ruleTexts.add(norm(rule.text));
    rules.push({ ...rule, id: `rule-${makeId()}` });
  }
  next.rules = rules;
  return next;
}

// 给分镜段落挂参考角色：提示词里点到名就挂谁（最多 limit 个）；一个都没点到
// （模型用英文写镜头、角色名是中文）就挂主角（第 1 个）。
// 兜底只挂一个而不是全挂：compileStoryPrompt 会把引用到的角色名写进提示词，
// 全挂会让 pickReferenceImages 把多张脸一起塞给图生图，反而破坏一致性。
export function pickBeatReferences(characters, promptText, limit = 3) {
  const chars = (characters || []).filter(c => c?.id);
  if (!chars.length) return [];
  const text = String(promptText || '');
  const mentioned = chars.filter(c => c.name && text.includes(String(c.name)));
  return (mentioned.length ? mentioned.slice(0, limit) : chars.slice(0, 1)).map(c => ({ id: String(c.id), role: 'character' }));
}

function pickCapableModel(models, kind) {
  const hits = (models || []).filter(m => m?.capabilities?.[kind] || (kind === 'novel' && m?.capabilities?.chat));
  const rank = m => { const id = String(m?.id || '').toLowerCase(); if (/3\.|latest|pro/.test(id)) return 0; if (/2\.5/.test(id)) return 1; if (/2\.1/.test(id)) return 2; if (/2\.0/.test(id)) return 3; return 4; };
  return hits.sort((a, b) => rank(a) - rank(b))[0] || null;
}

// 原著来源：要么直接粘贴正文，要么指定小说工坊的一本书（可选只要哪几章）。
// 两条路都必须能说清"到底拿了多少字"——不声不响地截断，用户会以为整本书都改编了。
async function collectAdaptSource(input, readNovelBook) {
  const pasted = String(input?.sourceText || '').trim();
  const bookId = String(input?.bookId || '').trim();
  const files = Array.isArray(input?.chapterFiles) ? input.chapterFiles.map(String).filter(Boolean) : [];
  if (!bookId) return { kind: pasted ? 'text' : 'empty', text: pasted, chapters: [], bookId: '', title: '' };
  if (typeof readNovelBook !== 'function') throw Object.assign(new Error('小说工坊未接入，无法按书导入'), { statusCode: 503 });
  const book = await readNovelBook({ bookId, files });
  const chapters = Array.isArray(book?.chapters) ? book.chapters : [];
  const body = chapters
    .map(c => `# ${c.title || c.file}\n${String(c.content || '').trim()}`)
    .filter(chunk => chunk.replace(/^#.*$/m, '').trim())
    .join('\n\n');
  return {
    kind: 'novel', bookId, title: String(book?.title || ''),
    chapters: chapters.map(c => ({ file: c.file, title: c.title || c.file, chars: Number(c.chars) || String(c.content || '').length })),
    text: pasted ? `${body}\n\n## 补充说明\n${pasted}` : body,
  };
}

export function createStoryOrchestrator({ root, clock = {}, adapters = {}, generateImage = null, generateVideo = null, startVideoJob = null, checkVideoJob = null, saveArtifact = null, saveArtifactFromFile = null, directChat = null, getDefaultModel = null, getModelList = null, readNovelBook = null }) {
  if (!root) throw new Error('story orchestrator 缺少 root');
  const withUpdated = project => ({ ...project, updatedAt: (clock.now || nowIso)() });
  // 前端模型下拉只能给出 {provider, id}，capabilities 会整个丢掉；而 negotiateCapabilities
  // 就是靠它判断"这个模型认不认参考图"。丢了就会对**每个显式选中的模型**报
  // 「当前模型不支持参考资产」，参考图通路被一条假降级关掉（真实项目里 4 次视频运行就是这样）。
  // 能力是目录里的既有事实，按 provider+id 回查补上，不让一次下拉选择把它抹掉。
  const withCatalogCapabilities = (model) => {
    if (!model?.id) return model;
    if (model.capabilities && Object.keys(model.capabilities).length) return model;
    const candidates = typeof getModelList === 'function' ? getModelList() : [];
    const hit = candidates.find(m => m?.provider === model.provider && m?.id === model.id);
    return hit?.capabilities ? { ...model, capabilities: hit.capabilities } : model;
  };
  const resolveModel = (explicit, kind, fallback) => {
    const isExplicit = explicit?.id && explicit.id !== 'auto' && explicit.provider !== 'auto';
    const candidates = typeof getModelList === 'function' ? getModelList() : [];
    return (isExplicit ? withCatalogCapabilities(explicit) : null) || pickCapableModel(candidates, kind) || (typeof getDefaultModel === 'function' ? getDefaultModel() : fallback);
  };
  // 单次生成能出几个变体（ComfyUI 的 batch_size）。上限刻意压到 4：
  // 每多一版就是一次真实计费调用，批量不该变成手滑烧钱。
  const VARIANT_MAX = 4;
  const kindLabel = { novel: '文字段落', image: '画面', video: '视频片段' };

  // 一次生成要做的事，全部在这里算清楚。**预览与实跑共用它**：
  // 两边各算一遍的话，「检查生成输入」显示的就不是真正会发出去的东西。
  // （ComfyUI 把整张工作流摆在画布上，人看得见每一步；元枢此前只能给一段提示词文本。）
  //
  // defaultRecipe：项目级默认配方的回退层。**seed 刻意不从它取**——配方里锁一个 seed
  // 是"这一镜要复现"，如果它悄悄成了全项目默认，每个段落都会拿到同一个 seed，
  // 那是没人要的副作用。想锁 seed 就在制作台上明写。
  const buildRunPlan = (project, scene, beat, input = {}, defaultRecipe = null) => {
    const kind = ['novel', 'image', 'video'].includes(input.kind) ? input.kind : beat.kind;
    const model = resolveModel(
      input.model && !(input.model.provider === 'auto' && input.model.id === 'auto') ? input.model : defaultRecipe?.model,
      kind, input.model,
    );
    const context = mergeBeatContext(project, scene, beat);
    // 全剧至今：以前只带继承链上的前 3 段，写到第 8 段时第 2 段发生的事模型看不见。
    // 挂到 context 上，由 compileStoryPrompt 写进提示词（见 story-context.mjs 的三条原则）。
    const soFar = buildStorySoFar(project, { maxChars: contextBudget(), excludeBeatId: beat.id });
    context.storySoFar = soFar;
    // 负向提示词（段落级 > 项目默认配方）。先写进提示词块（所有通道都吃、都看得见），
    // 再作为 negative 传给图像通道——上游认不认那个字段是另一回事，但请求里必须看得见。
    const negative = String(input.negative ?? beat.negative ?? defaultRecipe?.negative ?? '').trim();
    // 配色卡（engine/color-cards.mjs）：这一次显式传的 > 段落上的 > 项目选的 > 没有。
    // 它落在镜头提示词的③色调槽——同一部戏的每一镜因此同色，不会这一镜暖那一镜冷。
    const colorCard = resolveColorCard(input?.colorCard ?? beat?.colorCard ?? project?.colorCardId ?? '');
    // 镜头规格（story-shot-prompt.mjs）：把景别/机位/运镜/光线/落幅/承接 + 风格库 + @资产引用
    // 编译成一条提示词，放在提示词最前面。只对画面/视频做——文字段落要的是故事状态文档。
    // 整段包在 try 里：**编译失败不许影响生成**，这只是"更好"，不是"必须"。
    const shotSpec = kind === 'novel' ? '' : (() => {
      try {
        const rawStyle = beat?.style || project?.style || project?.bible?.style?.code || project?.bible?.style?.style
          || project?.bible?.style?.name || project?.bible?.style?.visual || '';
        const shot = shotFieldsFromBeat(beat);
        const found = assetRefsForShot({ bible: project.bible, scene, text: `${beat?.prompt || ''} ${beat?.dialogue || ''} ${scene?.title || ''}` });
        const refs = splitRefs(found, scene?.title);
        return compileShotPrompt({
          style: resolveStyle(rawStyle), shot, refs, kind, colorCard,
          // 时长：这一次显式传的 > 段落上存的。它不只是提示词里的一行字，
          // 也是配音/剪辑对表的依据（【时长】4s）。
          durationSec: Number(input?.params?.seconds ?? beat?.params?.seconds ?? defaultRecipe?.params?.seconds) || null,
          negative,
        });
      } catch { return ''; }
    })();
    const compiled = compileStoryPrompt({ bible: project.bible, scene, beat, inherited: context, negative, shotSpec, colorCard });
    // seed 不再靠运气：用户没指定就现掷一个**并记下来**，这条 run 因此可复现。
    // 以前 run.seed 恒为 undefined，而能力声明却写着支持固定 seed——声称支持却从未生效。
    //
    // 取值范围必须落在上游认的区间里（SEED_RANGE，Agnes 图像接口是 -1..999）：
    // 上一版 randomSeed() 掷的是 0..2^31-1，于是**每一张画面都被 400 拒掉**，
    // 界面只报"图像模型未返回图片"。超出范围时**夹到区间内并如实告诉用户**——
    // 悄悄改掉用户填的 seed 会砸掉"填 42 就能复现"这句话，所以 run.seed 记的是实际发出去的那个。
    const asked = Number(input?.seed);
    const resolvedSeed = Number.isFinite(asked) && input?.seed !== null && input?.seed !== ''
      ? clampSeed(asked)
      : { seed: crypto.randomInt(SEED_RANGE.min, SEED_RANGE.max + 1), clamped: false };
    const seed = resolvedSeed.seed;
    const variants = Math.max(1, Math.min(VARIANT_MAX, Number(input?.variants) || Number(defaultRecipe?.variants) || 1));
    // 参考图策略：显式 > 段落 > 项目默认配方 > 按类型的默认（见 story-recipes.defaultRefStrategy）
    const refStrategy = normalizeRefStrategy(input.reference ?? beat.reference ?? defaultRecipe?.reference, kind);
    const caps = capabilitiesFor(kind, model);
    const materials = Array.isArray(context.materials) ? context.materials : [];
    const picked = caps.supported.reference ? pickReferenceImages(project, beatReferenceText(beat)) : [];
    const materialImages = caps.supported.reference ? materials.filter(m => m.type === 'image' && m.url).map(m => m.url) : [];
    const materialVideos = materials.filter(m => m.type === 'video' && m.url).map(m => m.url);
    // 谁优先由策略决定（默认：画面素材优先、视频定妆照优先），张数也由策略定（0 = 明确不用参考图）
    const pool = refStrategy.prefer === 'material'
      ? [...materialImages, ...picked]
      : [...picked, ...materialImages];
    const orderedImages = refStrategy.images > 0 ? [...new Set(pool)].slice(0, refStrategy.images) : [];
    const usedRefs = orderedImages;
    const notes = [];
    if (resolvedSeed.clamped) notes.push(`上游只接受 ${SEED_RANGE.min}–${SEED_RANGE.max} 的 seed，你填的 ${resolvedSeed.asked} 已按 ${resolvedSeed.seed} 上送`);
    const upstreamImages = [];
    for (const ref of orderedImages) {
      const r = materializeMedia(ref, { wsRoot: root });
      if (r.value) upstreamImages.push(r.value);
      else if (r.note) notes.push(`参考图未上送：${r.note}`);
    }
    const upstreamVideos = [];
    for (const ref of materialVideos.slice(0, 2)) {
      const r = materializeMedia(ref, { wsRoot: root });
      if (r.value) upstreamVideos.push(r.value);
      else if (r.note) notes.push(`视频素材未上送：${r.note}`);
    }
    // 挂载了素材就要在产物历史里留下痕迹：没有它，"这一段用过哪些素材"事后无从对账
    const materialAssets = materials.map((m, i) => ({ id: m.id || `material-${i + 1}`, role: m.type === 'text' ? 'source-text' : 'reference', type: m.type, ...(m.url ? { url: m.url } : {}), ...(m.name ? { name: m.name } : {}) }));
    // 参数：项目默认配方打底，显式传的覆盖它
    const params = { ...(defaultRecipe?.params || {}), ...(input.params && typeof input.params === 'object' ? input.params : {}) };
    const adapterParams = {
      ...params,
      ...(negative ? { negative } : {}),
      ...(upstreamVideos.length ? { videos: upstreamVideos } : {}),
    };
    return { kind, model, context, compiled, negative, seed, variants, refStrategy, caps, usedRefs, upstreamImages, params, adapterParams, materialAssets, notes, defaultRecipe };
  };

  // 把 plan 摊成「这次到底会做什么」的清单给界面看。步骤可见，是 ComfyUI 那种画布的核心价值。
  const describeRunPlan = (plan, run) => {
    const steps = [
      { label: '输出类型', detail: kindLabel[plan.kind] || plan.kind },
      { label: '模型', detail: plan.model?.provider ? `${plan.model.provider}/${plan.model.id}` : '（未指定，交给上游默认）' },
      { label: 'seed', detail: plan.variants > 1 ? `${plan.seed} ~ ${plan.seed + plan.variants - 1}（${plan.variants} 个变体）` : String(plan.seed) },
      { label: '参考图', detail: plan.refStrategy.images === 0 ? '不使用（配方/设置里把参考图关掉了）' : plan.usedRefs.length ? `${plan.usedRefs.length} 张` : plan.caps.supported.reference ? '无（没有可用定妆照/素材）' : '未注入（模型未声明支持参考资产）' },
      { label: '参考图策略', detail: plan.refStrategy.images === 0 ? '不用参考图' : `${plan.refStrategy.images} 张 · ${plan.refStrategy.prefer === 'material' ? '素材优先' : '定妆照优先'}` },
      { label: '参考图清单', detail: plan.usedRefs.map((u, i) => `${i + 1}. ${String(u).slice(0, 90)}`).join('\n') || '—' },
      { label: '挂载素材', detail: plan.materialAssets.length ? plan.materialAssets.map(a => `${a.type}:${a.name || a.url || a.id}`).join('、') : '无' },
      { label: '负向提示词', detail: plan.negative ? `${plan.negative}${plan.defaultRecipe ? `（段落没写，取自项目默认配方「${plan.defaultRecipe.name}」）` : ''}` : '未设置' },
      { label: '上送参数', detail: JSON.stringify(plan.adapterParams).slice(0, 300) || '—' },
      { label: '全剧上下文', detail: plan.context?.storySoFar?.text ? `${plan.context.storySoFar.chars} 字（${plan.context.storySoFar.scenes} 场、含 ${plan.context.storySoFar.proseBeats} 段已写正文${plan.context.storySoFar.truncated ? '；**因长度上限砍掉了更早的部分**' : ''}）` : '无（这个项目还没有可追溯的成文内容）' },
    ];
    if (plan.defaultRecipe) steps.unshift({ label: '项目默认配方', detail: `「${plan.defaultRecipe.name}」在段落没说的地方生效（模型/参数/负向/变体数/参考图策略）` });
    const warn = [...(plan.caps.degradation || []), ...(plan.notes || []), ...(run?.degradation || [])].filter(Boolean);
    if (warn.length) steps.push({ label: '注意', detail: [...new Set(warn)].join('；') });
    return steps;
  };

  // 结构化 JSON 任务优先用**非推理**模型：推理模型的思考会混进 content，把 JSON 淹没。
  // handleStoryAssist 早就这么做，storyboard 一开始漏了 —— 2026-09-14 真实调用即踩到：
  // 返回的 content 是"我们需要回答用户。要求只返回 JSON…"的思路，解析自然失败。
  const pickJsonModel = (explicit) => {
    const isExplicit = explicit?.id && explicit.id !== 'auto' && explicit.provider !== 'auto';
    if (isExplicit) return explicit;
    const available = typeof getModelList === 'function' ? getModelList() : [];
    return available.find(m => m?.capabilities?.chat && !m.reasoning && /agnes-3\.0-flash/i.test(m.id))
      || available.find(m => m?.capabilities?.chat && !m.reasoning)
      || (typeof getDefaultModel === 'function' ? getDefaultModel() : null);
  };
  // ── 合成前把片段**搞到本地**（docs/NAMING.md 第三节的本地化契约）──
  // 外站给的是几小时到几天就失效的临时链接；ffmpeg 也只认本地文件。
  // 所以遇到外链不是"拼不了"，而是**先下载到本地再拼**——这是契约规定的默认动作。
  // 早先这里只认"本地已有文件"，把外链判成拼不进去，等于把契约做丢了。
  //
  // 只有两种情况才真的拼不了，而且都要说清原因：
  //   1) 落盘实现没接入（服务端没给 saveArtifact）——配置问题；
  //   2) 下载失败（SSRF 守卫拦下内网地址、上游 404/502、超过 50MB 等）——saveArtifact 会给出 reason。
  const localizeClip = async (run) => {
    const asset = (run.outputAssets || []).find(a => a?.type === 'video' && a.url);
    if (!asset?.url) return { error: '这一版没有视频成品' };
    const got = await pullToLocal(asset.url, { type: 'video', prompt: run.promptText || `${run.beatId || ''} 片段`, root, saveArtifact });
    if (!got.ok) return { error: got.reason };
    return { file: localPathFromArtifactUrl(got.url, root), url: got.url, localized: !got.alreadyLocal, from: got.from };
  };

  // 挑片段（或"每段取最后一次成功"）→ 逐段搞到本地 → 给出可拼的清单。
  // 挑不出来的一律进 skipped 带原因：静默少拼一段，比直接报错难查得多。
  const prepareFilmClips = async (project, input = {}) => {
    const clips = [];
    const skipped = [];
    const localized = [];
    const collect = async ({ scene, run, beatId, index }) => {
      if (!['succeeded', 'degraded'].includes(run.status)) {
        skipped.push({ index, beatId, runId: run.id, reason: `这一版状态是「${run.status}」，没有成品可拼` });
        return;
      }
      const got = await localizeClip(run);
      if (got.error) { skipped.push({ index, beatId, runId: run.id, reason: got.error }); return; }
      if (got.localized) localized.push({ beatId, runId: run.id, from: got.from, url: got.url });
      clips.push({ sceneId: scene.id, beatId, runId: run.id, file: got.file, url: got.url, index });
    };
    if (Array.isArray(input.clips)) {
      for (const [i, pick] of input.clips.entries()) {
        const runId = String(pick?.runId || '');
        const beatId = String(pick?.beatId || '');
        if (!runId || !beatId) { skipped.push({ index: i, beatId, runId, reason: '这一条没写清是哪一段的哪一版' }); continue; }
        let hit = null;
        for (const scene of project.scenes || []) {
          const run = (scene.outputs || []).find(r => String(r.id) === runId);
          if (run) { hit = { scene, run }; break; }
        }
        if (!hit) { skipped.push({ index: i, beatId, runId, reason: '这一版已经不在了（可能刚被删掉）' }); continue; }
        if (String(hit.run.beatId) !== beatId) { skipped.push({ index: i, beatId, runId, reason: '这一版不属于这一段' }); continue; }
        await collect({ scene: hit.scene, run: hit.run, beatId, index: i });
      }
      return { clips, skipped, localized };
    }
    // 没挑就按分镜顺序取"最后一次成功"——外链同样会先下载到本地，不再被静默漏掉
    for (const scene of project.scenes || []) {
      for (const beat of scene.beats || []) {
        const run = [...(scene.outputs || [])].reverse().find(r => r?.beatId === beat.id && ['succeeded', 'degraded'].includes(r.status));
        if (run) await collect({ scene, run, beatId: beat.id, index: clips.length });
      }
    }
    return { clips, skipped, localized };
  };
  // 收尾共用逻辑：**只此一份**。单条「查一次」与批量收尾必须走同一段判定，
  // 否则两条路的"出片/还在排队/真失败"迟早会给出不一样的说法。
  // 就地改 run（调用方决定何时落盘——批量收尾只写一次盘）。
  const settleRun = async (run) => {
    if (!run.taskId) {
      // 没有任务号就没得查：这一版是创建阶段就断了的孤儿，如实标失败
      run.status = 'failed'; run.finishedAt = (clock.now || nowIso)();
      run.degradation = [...(run.degradation || []), '这一版没有任务号，无法查询上游（多半是创建阶段就断了）'];
      return { status: 'failed', settled: true, degradation: run.degradation };
    }
    const adapter = resolvedAdapters[run.kind] || resolvedAdapters.video;
    const result = typeof adapter?.settle === 'function'
      ? await adapter.settle({ taskId: run.taskId, model: run.model, promptText: run.promptText })
      : { status: 'failed', error: '视频引擎未接入（缺 checkVideoJob）' };
    if (result?.status === 'running') {
      // 还在排队：**什么也不改**，把上游状态带回去让界面说清楚
      return { status: 'running', settled: false, upstream: result.upstream || 'pending', waitedMs: waitedMs(run, clock) };
    }
    if (result?.output) {
      run.outputAssets = [{ id: `${run.id}-output`, role: 'output', ...result.output }];
      const reported = Array.isArray(result.output.degradation) ? result.output.degradation.filter(Boolean).map(String) : [];
      if (reported.length) run.degradation = [...(run.degradation || []), ...reported];
      run.status = run.degradation?.length ? 'degraded' : 'succeeded';
    } else {
      run.status = 'failed';
      run.degradation = [...(run.degradation || []), result?.error || '上游返回失败'];
    }
    run.finishedAt = (clock.now || nowIso)();
    return { status: run.status, settled: true, waitedMs: waitedMs(run, clock), ...(run.degradation?.length ? { degradation: run.degradation } : {}) };
  };
  const resolvedAdapters = {
    image: adapters.image || createImageAdapter({ generateImage, saveArtifact }),
    novel: adapters.novel || createNovelAdapter({ directChat }),
    video: adapters.video || createVideoAdapter({ generateVideo, startVideoJob, checkVideoJob, saveArtifact }),
  };
  // 项目级默认配方：段落自己没说的地方由它兜底（模型/参数/负向/变体数/参考图策略）。
  // 找不到（被删了）就当没有——**不报错**：一条配方被删不该让整个项目生成不了。
  const loadDefaultRecipe = async (project) => {
    const id = project?.defaultRecipeId;
    if (!id) return null;
    try { return (await listRecipes(root)).find(r => r.id === id) || null; } catch { return null; }
  };
  return {
    list: () => listProjects(root),
    create: async input => { const project = createProject(input, clock); await writeProject(root, project); return project; },
    get: id => readProject(root, id),
    patch: async (id, changes) => {
      const current = await readProject(root, id);
      const next = withUpdated({ ...current, ...changes, bible: changes?.bible ? { ...current.bible, ...changes.bible } : current.bible, scenes: changes?.scenes || current.scenes });
      validateProject(next);
      await writeProject(root, next);
      return next;
    },
    previewRun: async (id, input) => {
      const project = await readProject(root, id);
      const scene = findScene(project, input?.sceneId);
      const beat = findBeat(scene, input?.beatId);
      if (!scene || !beat) throw Object.assign(new Error('sceneId 或 beatId 不存在'), { statusCode: 400 });
      // 预览与实跑**共用同一个 plan**：两边各算一次的话，
      // 「检查生成输入」显示的就不是真正会发出去的东西了（这正是它以前只敢显示提示词的原因）。
      const plan = buildRunPlan(project, scene, beat, input, await loadDefaultRecipe(project));
      const run = createGenerationRun({ ...input, kind: plan.kind, model: withCatalogCapabilities(plan.model), projectId: id, sceneId: scene.id, beatId: beat.id, seed: plan.seed, params: plan.params, inputAssets: input?.inputAssets || plan.compiled.referenceIds.map(assetId => ({ id: assetId, role: 'reference' })) }, clock);
      // 台词时间轴随预览一起下发：语速常量只有一份（story-craft 的 SPEECH），
      // 前端**不许**自己再实现一套——否则体检说"说不完"、界面说"还富余"，用户不知道信谁。
      // 只读、纯计算，不写盘：预览本来就是"这次会发出去什么"的窗口。
      const timeline = computeTimeline(syncLines(beat).lines);
      return { project, run, context: { ...plan.compiled, prompt: plan.compiled.text }, timeline, plan: describeRunPlan(plan, run) };
    },
    runGeneration: async (id, input = {}) => {
      const project = await readProject(root, id);
      const scene = findScene(project, input.sceneId);
      const beat = findBeat(scene, input.beatId);
      if (!scene || !beat) throw Object.assign(new Error('sceneId 或 beatId 不存在'), { statusCode: 400 });
      const plan = buildRunPlan(project, scene, beat, input, await loadDefaultRecipe(project));
      // 段号（跨场景连续）在生成时定格，随产物一起存下来——见 createGenerationRun 里的说明
      const beatNo = (() => {
        let n = 0;
        for (const s of project.scenes || []) for (const b of s.beats || []) { n += 1; if (b.id === beat.id) return n; }
        return undefined;
      })();
      const adapter = resolvedAdapters[plan.kind];
      const runs = [];
      // 批量变体（ComfyUI 的 batch_size）：一次点击出 N 版，seed 依次递增，
      // 每版都是一条独立 run，于是天然落进「本段结果」和「作品列表」——不需要新的展示概念。
      for (let i = 0; i < plan.variants; i++) {
        // 变体 seed 依次递增，但**不许越过上游区间**：999 + 变体数会直接换来一个 400。
        // 到头了就绕回区间开头（宁可两版撞 seed，也不能因为"第 4 版"整批失败）。
        const seed = (plan.seed + i) % (SEED_RANGE.max + 1);
        const run = createGenerationRun({
          ...input, kind: plan.kind, model: plan.model, projectId: id, sceneId: scene.id, beatId: beat.id,
          beatNo, sceneTitle: scene.title, seed, params: plan.params,
          inputAssets: input.inputAssets || plan.compiled.referenceIds.map(assetId => ({ id: assetId, role: 'reference' })),
        }, clock);
        if (plan.usedRefs.length) run.referenceImages = plan.usedRefs;
        if (plan.negative) run.negative = plan.negative;
        // 记下这一趟用的参考图策略：事后要能回答"为什么这张图没带定妆照"
        run.reference = { images: plan.refStrategy.images, prefer: plan.refStrategy.prefer, used: plan.usedRefs.length };
        // 上送用的那份和记录下来的那份分开：记录存原始引用，上送才内联（见 plan.materialize）
        // 只在真有话说时才写 degradation——空数组会让"没有降级"变成另一种形状，
        // 也白白撑大项目 JSON。
        if (plan.notes.length) run.degradation = [...(run.degradation || []), ...plan.notes];
        // 记下这次到底发了什么（截断）。视频要异步收尾，得靠它把当时的提示词带回来；
        // 顺带让"产物是历史"这句话在文本层面也成立。
        run.promptText = String(plan.compiled.text).slice(0, 8000);
        run.status = 'running';
        appendRun(scene, run);
        project.updatedAt = (clock.now || nowIso)();
        await writeProject(root, project);
        const useAsync = plan.kind === 'video' && typeof adapter?.start === 'function';
        if (!adapter?.generate && !useAsync) {
          run.status = 'failed'; run.degradation = [...(run.degradation || []), `${plan.kind}: 当前未接入生成适配器`];
          run.finishedAt = (clock.now || nowIso)();
          await writeProject(root, project);
          runs.push(run);
          continue;
        }
        let result;
        try {
          // 视频走"只创建、立刻返回任务号"：上游排队常常好几分钟，让一个 HTTP 请求干等，
          // 既会被网关掐断（工坊早就因此改成短轮询），也会让用户以为卡死。
          // 图像/文字是同步的，照旧一次拿结果。
          result = useAsync
            ? await adapter.start({
              prompt: plan.compiled.text, model: plan.model, seed,
              params: plan.adapterParams, references: plan.compiled.referenceIds, referenceImages: plan.upstreamImages,
            })
            : await adapter.generate({
              prompt: plan.compiled.text, model: plan.model, seed,
              params: plan.adapterParams, references: plan.compiled.referenceIds, referenceImages: plan.upstreamImages,
            });
        } catch (error) { result = { status: 'failed', error: String(error?.message || error).slice(0, 300) }; }
        // 只创建成功：这一版仍是 running，等 checkRun 或前端轮询来收尾
        if (result?.status === 'running' && result.taskId && !result.output) {
          run.taskId = result.taskId;
          run.queuedAt = (clock.now || nowIso)();
          const notes = Array.isArray(result.degradation) ? result.degradation.filter(Boolean).map(String) : [];
          if (notes.length) run.degradation = [...(run.degradation || []), ...notes];
          if (plan.materialAssets.length) run.inputAssets = [...(run.inputAssets || []), ...plan.materialAssets];
          await writeProject(root, project);
          runs.push(run);
          continue;
        }
        if (result?.output) run.outputAssets = [{ id: `${run.id}-output`, role: 'output', ...result.output }];
        // 产物历史里记下**原始引用**（不记内联后的 base64）：事后要能对账"这一段用过哪些素材"
        if (plan.materialAssets.length) run.inputAssets = [...(run.inputAssets || []), ...plan.materialAssets];
        // 适配器如实上报的降级（例如上游把参考图摘掉了）必须并进来，否则这一趟看起来是"成功"
        const reported = Array.isArray(result?.output?.degradation) ? result.output.degradation.filter(Boolean).map(String) : [];
        if (reported.length) run.degradation = [...(run.degradation || []), ...reported];
        if (result?.status === 'succeeded') run.status = run.degradation?.length ? 'degraded' : 'succeeded';
        else { run.status = 'failed'; run.degradation = [...(run.degradation || []), result?.error || '生成失败']; }
        run.finishedAt = (clock.now || nowIso)();
        await writeProject(root, project);
        runs.push(run);
      }
      return { project, run: runs[runs.length - 1], runs, context: plan.compiled, plan: describeRunPlan(plan, runs[0]), ...(plan.kind === 'video' ? { pollWindowMs: videoPollWindowMs() } : {}) };
    },
    // 收尾一次：查上游任务号，出片就落盘、真失败就记失败，还在排队就原样返回。
    // **一次调用只查一次**——等多久由前端轮询或人类点「查一次」决定，
    // 不在一次请求里干等（那正是原来 180s 超时的成因）。
    checkRun: async (id, input = {}) => {
      const project = await readProject(root, id);
      const scene = findScene(project, input.sceneId);
      const run = (scene?.outputs || []).find(r => r.id === input.runId);
      if (!scene || !run) throw Object.assign(new Error('sceneId 或 runId 不存在'), { statusCode: 400 });
      if (run.status !== 'running') return { project, run, status: run.status, settled: false };
      const outcome = await settleRun(run);
      await writeProject(root, project);
      return { project, run, status: outcome.status, ...outcome };
    },
    // 一次收尾**多个**运行：批量生成会同时挂 N 个视频任务号，逐个查就是 N 个请求、
    // N 次读盘写盘、N 轮上游问答（Lovart 把"查询"单独分一档限流，并规定同一 thread 同时只跑一个生成；
    // 我们创建已经是串行的，但收尾查询必须合并：一次读盘、一轮问答、一次写盘）。
    checkRuns: async (id, input = {}) => {
      const project = await readProject(root, id);
      const wanted = new Set((Array.isArray(input.runIds) ? input.runIds : []).map(String));
      if (!wanted.size) throw Object.assign(new Error('要给 runIds（要收尾哪些运行）'), { statusCode: 400 });
      const results = [];
      let touched = false;
      for (const scene of project.scenes || []) {
        for (const run of scene.outputs || []) {
          if (!wanted.has(String(run.id))) continue;
          if (run.status !== 'running') {
            results.push({ runId: run.id, sceneId: scene.id, status: run.status, settled: false });
            continue;
          }
          const outcome = await settleRun(run);
          if (outcome.settled) touched = true;
          results.push({ runId: run.id, sceneId: scene.id, kind: run.kind, ...outcome });
        }
      }
      if (touched) await writeProject(root, project);
      const known = new Set(results.map(r => r.runId));
      return {
        project,
        results,
        pending: results.filter(r => !r.settled && r.status === 'running').map(r => r.runId),
        // 找不到的运行 id 如实回报：可能项目被改过，不能假装查过了
        missing: [...wanted].filter(runId => !known.has(runId)),
      };
    },
    pollWindowMs: () => videoPollWindowMs(),
    // ── 分集：短剧/系列内容的组织单位（PINNGOO 的"分集短剧"、LibTV 的"按集拆镜头"都是这个）──
    episodes: async (id) => {
      const project = await readProject(root, id);
      const groups = groupScenesByEpisode(project);
      return {
        episodes: normalizeEpisodes(project.episodes).map(e => ({ ...e, stats: episodeStats(project, e.id) })),
        groups: groups.map(g => ({ episode: g.episode, scenes: g.scenes.map(s => ({ id: s.id, title: s.title, beats: (s.beats || []).length })) })),
        unassigned: (project.scenes || []).filter(s => !s.episodeId).length,
      };
    },
    addEpisode: async (id, input = {}) => {
      const project = await readProject(root, id);
      const episode = createEpisode({ ...input, episodes: project.episodes }, clock);
      const next = withUpdated({ ...project, episodes: normalizeEpisodes([...(project.episodes || []), episode]) });
      validateProject(next);
      await writeProject(root, next);
      return { project: next, episode };
    },
    updateEpisode: async (id, input = {}) => {
      const project = await readProject(root, id);
      const target = String(input.episodeId || '');
      const list = normalizeEpisodes(project.episodes);
      if (!list.some(e => e.id === target)) throw Object.assign(new Error('这一集不存在'), { statusCode: 404 });
      const episodes = list.map(e => e.id !== target ? e : {
        ...e,
        ...(input.title != null ? { title: String(input.title).trim().slice(0, 60) || e.title } : {}),
        ...(input.summary != null ? { summary: String(input.summary).trim().slice(0, 600) } : {}),
        ...(input.no != null && Number(input.no) > 0 ? { no: Math.round(Number(input.no)) } : {}),
        ...(input.targetSeconds != null ? { targetSeconds: Number(input.targetSeconds) > 0 ? Math.round(Number(input.targetSeconds)) : undefined } : {}),
      });
      const next = withUpdated({ ...project, episodes: normalizeEpisodes(episodes) });
      validateProject(next);
      await writeProject(root, next);
      return { project: next, episodes: next.episodes };
    },
    // 删集**只解绑，不删场**：删一个集就把内容一起带走，是最不能接受的一种"顺手"
    removeEpisode: async (id, input = {}) => {
      const project = await readProject(root, id);
      const stripped = removeEpisode(project, input.episodeId);
      const next = withUpdated(renumberEpisodes(stripped));
      validateProject(next);
      await writeProject(root, next);
      return { project: next, unassigned: next.scenes.filter(s => !s.episodeId).length };
    },
    assignScene: async (id, input = {}) => {
      const project = await readProject(root, id);
      const next = withUpdated(assignSceneToEpisode(project, input.sceneId, input.episodeId));
      validateProject(next);
      await writeProject(root, next);
      return { project: next };
    },
    scriptStats: async (id) => scriptStats(await readProject(root, id)),
    // ── 创作方法包（Skill）──
    // 内置 + 自己存的，跨项目共用（所以和配方一样落在项目目录之外）。
    methods: () => listMethods(root),
    saveMethod: (input) => saveMethod(root, input, clock),
    deleteMethod: (id) => deleteMethod(root, id),
    // 把"这个项目跑通的打法"存成方法包：结构照抄，内容不抄（方法要能跨项目用）。
    captureMethod: async (id, input = {}) => {
      const project = await readProject(root, id);
      const captured = captureFromProject(project, { name: input.name, clock });
      const saved = await saveMethod(root, captured, clock);
      return { ...saved, capturedFrom: { id: project.id, title: project.title } };
    },
    // 套用到项目：只写**结构性**的东西。
    // 已有目标时长的集**不动**（用户自己排过的时长不该被方法包覆盖），
    // 已有画风时也不覆盖（人工调好的视觉基调优先）——方法包是建议，不是接管。
    applyMethod: async (id, input = {}) => {
      const project = await readProject(root, id);
      const methodId = String(input.methodId || '');
      if (!methodId) {
        const next = withUpdated({ ...project });
        delete next.methodId;
        validateProject(next);
        await writeProject(root, next);
        return { project: next, method: null, applied: { episodes: 0, style: false } };
      }
      const method = await methodOf(root, methodId);
      if (!method) throw Object.assign(new Error('这个方法包不存在'), { statusCode: 404 });
      let episodesTouched = 0;
      const episodes = normalizeEpisodes(project.episodes).map(e => {
        if (e.targetSeconds || !method.targetSeconds) return e;
        episodesTouched += 1;
        return { ...e, targetSeconds: method.targetSeconds };
      });
      const styleEmpty = !String(project.bible?.style?.visual || '').trim();
      const bible = styleEmpty && method.styleHint ? { ...project.bible, style: { ...(project.bible?.style || {}), visual: method.styleHint } } : project.bible;
      const next = withUpdated({ ...project, methodId, ...(episodes.length ? { episodes } : {}), bible });
      validateProject(next);
      await writeProject(root, next);
      return { project: next, method, applied: { episodes: episodesTouched, style: styleEmpty && Boolean(method.styleHint) } };
    },
    // ── 剧本导出（Laper 的地基：能出图出片，还要能拿出一个能给人看的剧本文件）──
    exportScript: async (id, input = {}) => {
      const project = await readProject(root, id);
      const format = String(input.format || 'txt');
      const out = renderScript(project, format);
      const safe = String(project.title || '未命名').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
      return { ...out, filename: `${safe}-剧本.${out.ext}`, stats: scriptStats(project), formats: Object.entries(SCRIPT_FORMATS).map(([k, v]) => ({ format: k, label: v.label })) };
    },
    // ── 与角色对台词（Laper 的 Playground）：检验台词像不像这个人 ──
    playground: async (id, input = {}) => {
      const project = await readProject(root, id);
      const scene = findScene(project, input.sceneId);
      const beat = findBeat(scene, input.beatId);
      if (!scene || !beat) throw Object.assign(new Error('sceneId 或 beatId 不存在'), { statusCode: 400 });
      const characters = Array.isArray(project.bible?.characters) ? project.bible.characters : [];
      const character = characters.find(c => String(c?.id) === String(input.characterId)) || characters[0];
      if (!character) throw Object.assign(new Error('这个故事还没有角色：先让 AI 补一段设定，或加一个角色'), { statusCode: 400 });
      const history = normalizePlayground(beat.playground);
      const soFar = buildStorySoFar(project, { maxChars: Math.min(contextBudget(), 6000), excludeBeatId: '' });
      // 候选模型按 handleStoryAssist 同一套路：指定的 → 非推理快模型 → 默认模型，
      // 试最多 2 个，并把**每个**失败原因带回来。短台词最怕推理模型把输出吃光。
      const available = typeof getModelList === 'function' ? getModelList() : [];
      const fast = available.find(m => m?.capabilities?.chat && !m.reasoning && /agnes-3\.0-flash/i.test(m.id))
        || available.find(m => m?.capabilities?.chat && !m.reasoning);
      const candidates = [input.model, fast, typeof getDefaultModel === 'function' ? getDefaultModel() : null]
        .filter((m, i, all) => m?.id && all.findIndex(x => x?.provider === m.provider && x?.id === m.id) === i);
      if (!candidates.length) throw Object.assign(new Error('没有可用的文本模型：先去模型页配一个'), { statusCode: 503 });
      const reasons = [];
      let reply = '', used = candidates[0];
      for (const model of candidates.slice(0, 2)) {
        try {
          const out = await runRoleplay({
            directChat, model, project, character, scene, beat, history,
            message: input.message, storySoFar: soFar.text,
          });
          reply = out.reply; used = model; break;
        } catch (e) { reasons.push(`${model?.provider}/${model?.id}：${String(e?.message || e).slice(0, 120)}`); }
      }
      if (!reply) throw new Error(`对台词失败（试过 ${reasons.length} 个模型）—— ${reasons.join('；')}`);
      // 对话留档：对台词是创作过程的一部分，"这个角色这么说过了"本身就是要保持一致的既成事实
      const at = (clock.now || nowIso)();
      const turns = [...history, { role: 'writer', text: String(input.message).trim(), at }, { role: 'character', text: reply, at }];
      const next = withUpdated({
        ...project,
        scenes: project.scenes.map(s => s.id !== scene.id ? s : { ...s, beats: s.beats.map(b => b.id !== beat.id ? b : { ...b, playground: normalizePlayground(turns) }) }),
      });
      validateProject(next);
      await writeProject(root, next);
      return { project: next, reply, character: { id: character.id, name: character.name || '' }, turns: normalizePlayground(turns), model: { provider: used?.provider || '', id: used?.id || '' } };
    },
    clearPlayground: async (id, input = {}) => {
      const project = await readProject(root, id);
      const scene = findScene(project, input.sceneId);
      const beat = findBeat(scene, input.beatId);
      if (!scene || !beat) throw Object.assign(new Error('sceneId 或 beatId 不存在'), { statusCode: 400 });
      const next = withUpdated({
        ...project,
        scenes: project.scenes.map(s => s.id !== scene.id ? s : { ...s, beats: s.beats.map(b => b.id !== beat.id ? b : { ...b, playground: [] }) }),
      });
      validateProject(next);
      await writeProject(root, next);
      return { project: next };
    },
    // 参考图资产：角色定妆照 / 场景参考图 / 道具参考图，三件共用一套流程，写回 bible 对应条目。
    // 角色那份是 2026-09-14 开的头（"锁定人物外貌"），场景与道具是 2026-09-15 补的：
    // 此前场景和道具只有文字，同一间屋子在两段里会长得不一样。
    generateAssetRef: async (id, input = {}) => {
      const project = await readProject(root, id);
      const assetType = input.assetType === 'location' ? 'location' : input.assetType === 'prop' ? 'prop' : 'character';
      const key = assetType === 'location' ? 'locations' : assetType === 'prop' ? 'props' : 'characters';
      const list = Array.isArray(project.bible?.[key]) ? project.bible[key] : [];
      const noun = assetType === 'character' ? '角色' : assetType === 'location' ? '场景' : '道具';
      if (!list.length) throw Object.assign(new Error(`这个故事还没有${noun}：先让 AI 补一段设定，或到下方设定里加一个${noun}`), { statusCode: 400 });
      const item = list.find(x => String(x?.id) === String(input.assetId)) || list[0];
      const adapter = resolvedAdapters.image;
      if (!adapter?.generate) throw Object.assign(new Error('图像引擎未接入'), { statusCode: 503 });
      const model = resolveModel(input.model, 'image', null);
      // 角色**形象变体**（Pavo 那种「基础形象 / 战斗装束 · 已添加形象 1/2」）：
      // 一个角色在不同段落要换装/换状态；只留一张定妆照，换装段落就只能靠嘴描述，一致性立刻掉。
      // 指定 lookName 且不存在时**建一张新的**——这样"生成这张新形象"一步就完成了。
      const looks = assetType === 'character' && Array.isArray(item.looks) ? item.looks : [];
      const wantId = String(input.lookId || '').trim();
      const wantName = String(input.lookName || '').trim();
      let look = wantId ? looks.find(l => String(l?.id) === wantId) : null;
      if (!look && wantName) look = looks.find(l => String(l?.name) === wantName) || { id: `look-${String(item.id || 'c')}-${looks.length + 1}`, name: wantName };
      if (!look && looks.length) look = looks[0];   // 没指定就当作"重做基础形象"
      // 第一次生成：把基础形象也**登记成一张 look**，角色从此统一有形象列表
      // （界面上的「已添加形象 1/2」要数得出来；否则"基础形象"是个隐形的第 0 张）。
      if (!look && assetType === 'character') look = { id: `look-${String(item.id || 'c')}-1`, name: '基础形象' };
      const prompt = assetType === 'character'
        ? buildPortraitPrompt({ bible: project.bible, character: item, look })
        : buildAssetPrompt({ bible: project.bible, assetType, item });
      const result = await adapter.generate({ prompt, model, params: { size: input.size } });
      const url = result?.output?.url;
      const label = assetType === 'character' ? (look ? `「${look.name || '基础形象'}」定妆照` : '定妆照') : `${noun}参考图`;
      if (!url) return { project, asset: item, assetType, look: look || null, status: 'failed', error: result?.error || `${label}生成失败`, model: result?.model };
      const localizeError = result?.output?.localizeError ? String(result.output.localizeError) : '';
      const patchItem = (x) => {
        if (x !== item) return x;
        if (!look) return { ...x, refImage: url };
        // 老角色（有 refImage、没有 looks）第一次加**新形象**时，先把既有的那张登记成「基础形象」——
        // 否则新形象会顶掉 refImage，等于把原来的定妆照弄丢了（真机踩到过：给林默加「战斗装束」，
        // 结果 refImage 也被改成战斗装束那张）。
        const nextLooks = [...looks];
        if (!nextLooks.length && x.refImage) nextLooks.push({ id: `look-${String(x.id || 'c')}-base`, name: '基础形象', refImage: x.refImage });
        const isNewBase = nextLooks.length === 0;   // 这个角色一张形象都还没有 → 这一张就是基础形象
        const idx = nextLooks.findIndex(l => String(l?.id) === String(look.id));
        const entry = { ...(idx >= 0 ? nextLooks[idx] : look), name: String(look.name || '基础形象'), refImage: url };
        if (idx >= 0) nextLooks[idx] = entry; else nextLooks.push(entry);
        // 只有**基础形象**（第一张）才回写 refImage：参考图挑选与连续性体检此前只认它，
        // 别让既有功能"看不见"新生成的形象；但第二张形象绝不该覆盖基础定妆照。
        return { ...x, looks: nextLooks, ...(isNewBase ? { refImage: url } : {}) };
      };
      const next = withUpdated({
        ...project,
        bible: { ...project.bible, [key]: list.map(patchItem) },
      });
      validateProject(next);
      await writeProject(root, next);
      // 参考图也可能没落到本地（下载失败时 saveArtifact 会把外站临时链接原样返回）。
      // 这件事**必须在返回值里说出来**：定妆照是要长期复用的锚点，挂在会过期的外链上，
      // 几天后人物一致性就悄悄失效了——而界面此前看起来是"生成成功"。
      // 返回**落盘后的那一份**（角色会多出 looks 与回写的 refImage）：调用方与界面按它渲染，
      // 之前用手拼的 { ...item, refImage } 会在有形象变体时丢掉 looks（测试当场抓到）。
      const savedItem = (next.bible[key] || []).find(x => String(x?.id) === String(item.id)) || item;
      return {
        project: next, asset: savedItem,
        look: look ? { ...look, refImage: url } : null,
        assetType, image: url, status: result.status, model: result.model,
        ...(localizeError ? { localizeError, note: `${label}已生成，但没能存到本地（${localizeError}）。当前用的是外站临时链接，过期后会失效——可以在设定面板里点「把外站的产物拉到本地」重试下载。` } : {}),
      };
    },
    // 角色定妆照：上面的一个特例，保留这个名字是因为既有调用方（与测试）按它工作
    generatePortrait: async (id, input = {}) => {
      const api = await createStoryOrchestrator({ root, clock, adapters, generateImage, generateVideo, startVideoJob, checkVideoJob, saveArtifact, saveArtifactFromFile, directChat, getDefaultModel, getModelList });
      const r = await api.generateAssetRef(id, { ...input, assetType: 'character', assetId: input.characterId });
      return { ...r, character: r.asset };
    },
    // 连续性体检：只读，不落盘。把"这次生成能不能保住人物一致性"的条件提前摊开。
    lint: async (id, input = {}) => {
      const project = await readProject(root, id);
      return lintStoryProject(project, { kind: input.kind || 'image', capabilities: input.capabilities || null });
    },
    // 配方（生成设置的具名资产）：存/列/删/导出/导入。跨项目共用，所以落在项目目录之外。
    listRecipes: input => listRecipes(root, input || {}),
    saveRecipe: input => saveRecipe(root, input, clock),
    deleteRecipe: id => deleteRecipe(root, id),
    importRecipes: payload => importRecipes(root, payload, clock),
    exportRecipes: async (ids) => {
      const all = await listRecipes(root);
      const want = Array.isArray(ids) && ids.length ? all.filter(r => ids.includes(r.id)) : all;
      return exportRecipes(want, clock);
    },
    // 一键分镜：一次生成整场分镜表并追加进项目，自动串好 inheritBeatId 继承链。
    // 之前 assist 只产出 1 段，用户得一段一段点「从此处继续」。
    //
    // 2026-09-15 补自动重试：实测同一提示词、请求 4 段，三次真实调用给的是 4 / 1 / 4 段
    // （agnes-3.0-flash）。要点 4 段只给 1 段是模型侧的抖动，对用户就是"这功能时好时坏"。
    // 段数明显不足时**再要一次**，并且把"重试过"如实告诉用户——不默默替他做决定。
    storyboard: async (id, input = {}) => {
      const project = await readProject(root, id);
      if (typeof directChat !== 'function') throw Object.assign(new Error('智能填充引擎未接入'), { statusCode: 503 });
      const idea = String(input.idea || '').trim().slice(0, 2000);
      const count = Math.max(2, Math.min(12, Number(input.count) || 6));
      const model = pickJsonModel(input.model);
      // 方法包（Skill）：项目上挂着就用它的方法与推理档位。
      // 这是 Lovart 那条"方法包决定怎么做，用户不必每次重新交代"的落点。
      const method = await methodOf(root, project.methodId);
      const brief = methodBrief(method);
      const budget = reasoningBudget(method?.reasoning, 'storyboard');
      const methodScenes = method?.scenesPerEpisode && method?.beatsPerScene
        ? `\n\n【本片方法】按每场约 ${method.beatsPerScene} 段组织，整场同一种 kind 更连贯。`
        : '';
      const basePrompt = buildStoryboardPrompt({ title: project.title, logline: project.logline, idea, current: project.bible, count, colorCard: resolveColorCard(project.colorCardId) })
        + (brief ? `\n\n${brief}` : '') + methodScenes;
      // 少于一半才算"明显不足"：模型偶尔给 count-1 段是正常波动，不该为它多烧一次调用。
      const short = n => n < Math.max(2, Math.ceil(count / 2));
      let storyboard = null, attempts = 0, retried = false, firstCount = 0;
      let prompt = basePrompt;
      while (attempts < 2) {
        attempts += 1;
        const result = await directChat(model, prompt, [], budget);
        if (!result?.text) {
          if (attempts === 1) { prompt = basePrompt; continue; }   // 没返回内容也值得再要一次
          throw new Error('分镜模型没有返回内容');
        }
        let parsed;
        try { parsed = parseStoryboard(result.text); }
        catch (error) {
          // 解析失败时把模型原文留在服务端日志里：不然只能看到"解析不出来"，无从判断是形状不符还是模型跑偏
          console.log(`[story] 分镜解析失败（模型 ${model?.provider}/${model?.id}，原文 ${String(result.text).length} 字）：${String(result.text).replace(/\s+/g, ' ').slice(0, 1200)}`);
          if (attempts === 1) { prompt = basePrompt; continue; }
          throw error;
        }
        if (attempts === 1) firstCount = parsed.beatCount;
        storyboard = parsed;
        if (!short(parsed.beatCount) || attempts === 2) break;
        // 第二次把话说明白：上一次只给了几段、这次必须给足
        retried = true;
        prompt = `${basePrompt}\n\n【补充要求】上一次你只给了 ${parsed.beatCount} 段，不够。这一次必须给足 ${count} 段（scenes 数组里每一段 beats 至少 1 条，合计不少于 ${count} 条），不要合并、不要省略、不要用省略号带过。`;
      }
      const scenes = [...(project.scenes || [])];
      // 新段落自动套用项目默认配方的**类型与负向**（模型/尺寸/seed 是每次生成时的选择，
      // 不落到段落上）。一键分镜一次产出十几段，正是"点了 10 遍同一套设置"最痛的地方。
      const stampRecipe = await loadDefaultRecipe(project);
      // 先并设定：段落引用要按**合并后**的角色 id 挂，否则引用指向的是不存在的 id。
      const bible = mergeStoryboardBible(project.bible, storyboard.bible);
      const cast = Array.isArray(bible.characters) ? bible.characters : [];
      let previousId = scenes.flatMap(s => s.beats || []).slice(-1)[0]?.id || '';
      const stamp = Date.now().toString(36);
      storyboard.scenes.forEach((scene, index) => {
        const beats = scene.beats.map((beat, beatIndex) => {
          const id = `beat-${stamp}-${index}-${beatIndex}`;
          const kind = ['novel', 'image', 'video'].includes(stampRecipe?.kind) ? stampRecipe.kind : beat.kind;
          const item = {
            id, kind, prompt: beat.prompt,
            ...(beat.dialogue ? { dialogue: String(beat.dialogue).slice(0, 2000) } : {}),
            // 镜头语言字段（景别/机位/运镜/光线/色调/落幅/承接）与时长必须落到段落上：
            // 它们是"镜头提示词编译器"（story-shot-prompt.mjs）的输入，
            // 在这里丢掉就等于让模型白写了一遍结构化分镜。
            ...(beat.shot && Object.keys(beat.shot).length ? { shot: beat.shot } : {}),
            ...(beat.params?.seconds ? { params: { ...(beat.params || {}) } } : {}),
            ...(stampRecipe?.negative ? { negative: stampRecipe.negative } : {}),
            references: pickBeatReferences(cast, beat.prompt),
            ...(previousId ? { inheritFromBeatId: previousId } : {}),
          };
          previousId = id;
          return item;
        });
        scenes.push({
          id: `scene-${stamp}-${index}`, index: scenes.length + 1,
          title: scene.title || `第 ${scenes.length + 1} 场`, summary: scene.summary, beats, outputs: [],
        });
      });
      const next = withUpdated({ ...project, bible, scenes });
      validateProject(next);
      await writeProject(root, next);
      return {
        project: next, beatCount: storyboard.beatCount, sceneCount: storyboard.scenes.length,
        characters: cast.length,
        characterNames: cast.map(c => String(c.name || '')).filter(Boolean),
        model: { provider: model?.provider || '', id: model?.id || '' },
        // 如实上报重试与段数偏差：用户要能看出"这次是模型第一次没给够、我替你又要了一遍"
        requested: count, attempts, retried,
        ...(firstCount && firstCount !== storyboard.beatCount ? { firstBeatCount: firstCount } : {}),
        ...(short(storyboard.beatCount) ? { short: true, note: `模型两次都只给了 ${storyboard.beatCount} 段（要的是 ${count} 段），可以再点一次或把想法写具体些` } : {}),
      };
    },
    // ── 原著改编：小说原文 → 集 + 场 + 段落，一次落进项目 ──
    // 元枢此前只能把小说工坊的章节当"文本素材"挂在某一段上，一整本书进来仍是一个大平铺，
    // 用户得自己数着第几场属于第几集。这里补的是 PINNGOO/Laper 那条主线：原著 → 分集大纲 → 分集剧本。
    //
    // 三个刻意的取舍：
    // 1) 先能**预览**再花钱：preview=true 只读书、只报字数与章节，不调模型；
    // 2) 段落 kind **不被项目默认配方覆盖**（与一键分镜相反）：改编出来的"哪段是文字、哪段出图、哪段出片"
    //    正是这一集的骨架，拿一个全局 kind 抹平等于把改编结果毁了；
    // 3) 解析不全**不算整体失败**：能出几集就落几集，哪几集没出来如实回报。
    adapt: async (id, input = {}) => {
      const project = await readProject(root, id);
      const source = await collectAdaptSource(input, readNovelBook);
      // 方法包决定"怎么改"：单集时长与集数优先照方法包来（用户显式填的优先），
      // 推理档位决定这次调用的预算（thinking 要多给输出余量，否则分集大纲会被截在半路）。
      const method = await methodOf(root, project.methodId);
      const budget = reasoningBudget(method?.reasoning, 'adapt');
      const episodeWish = Math.max(1, Math.min(60, Number(input.episodes) || 4));
      const secondsPerEpisode = Math.max(15, Math.min(1800, Number(input.secondsPerEpisode) || method?.targetSeconds || 90));
      const cap = 60000;
      const usedChars = Math.min(source.text.length, cap);
      const sourceBrief = {
        kind: source.kind, bookId: source.bookId, title: source.title,
        chapters: source.chapters, chars: source.text.length, usedChars,
        truncated: source.text.length > cap,
      };
      if (input.preview) {
        return {
          preview: true, source: sourceBrief, episodeWish, secondsPerEpisode,
          // 预览要能回答"这次会改编成什么样"，所以把它预估的规模也摊开
          note: !source.text.trim()
            ? '还没有原文：粘贴小说正文，或选一本小说工坊的书'
            : `将占提示词约 ${usedChars} / ${cap} 字${source.text.length > cap ? '（原文超限，只取前 6 万字）' : ''}，按 ${episodeWish} 集 × ${secondsPerEpisode} 秒改编`,
        };
      }
      if (!source.text.trim()) throw Object.assign(new Error('没有可改编的原文：粘贴小说正文，或选一本小说工坊的书'), { statusCode: 400 });
      if (typeof directChat !== 'function') throw Object.assign(new Error('改编引擎未接入'), { statusCode: 503 });
      const model = pickJsonModel(input.model);
      const basePrompt = buildAdaptPrompt({
        title: project.title, sourceText: source.text, episodes: episodeWish,
        secondsPerEpisode, idea: String(input.idea || '').trim().slice(0, 500),
      }) + (methodBrief(method) ? `\n\n${methodBrief(method)}` : '');
      let parsed = null, attempts = 0, retried = false, firstEpisodes = 0;
      let prompt = basePrompt;
      while (attempts < 2) {
        attempts += 1;
        const result = await directChat(model, prompt, [], budget);
        if (!result?.text) {
          if (attempts === 1) continue;
          throw new Error('改编模型没有返回内容');
        }
        let candidate;
        try { candidate = parseAdapt(result.text); }
        catch (error) {
          console.log(`[story] 改编解析失败（模型 ${model?.provider}/${model?.id}，原文 ${String(result.text).length} 字）：${String(result.text).replace(/\s+/g, ' ').slice(0, 1200)}`);
          if (attempts === 1) continue;
          throw error;
        }
        if (attempts === 1) firstEpisodes = candidate.episodeCount;
        parsed = candidate;
        // 集数少于一半才算"明显不足"：模型多一集少一集是正常波动，不值得为它多烧一次调用
        if (candidate.episodeCount >= Math.max(1, Math.ceil(episodeWish / 2)) || attempts === 2) break;
        retried = true;
        prompt = `${basePrompt}\n\n【补充要求】上一次你只给了 ${candidate.episodeCount} 集，不够。这一次必须给足 ${episodeWish} 集，每集都要有 title / summary / scenes，且每场都要有 beats，不要合并、不要省略、不要用省略号带过。`;
      }
      const stampRecipe = await loadDefaultRecipe(project);
      const bible = mergeStoryboardBible(project.bible, parsed.bible);
      const cast = Array.isArray(bible.characters) ? bible.characters : [];
      const stamp = Date.now().toString(36);
      const scenes = [...(project.scenes || [])];
      const episodes = normalizeEpisodes(project.episodes);
      const baseNo = episodes.length ? Math.max(...episodes.map(e => Number(e.no) || 0)) : 0;
      let previousId = scenes.flatMap(s => s.beats || []).slice(-1)[0]?.id || '';
      const createdEpisodes = [];
      const createdSceneIds = [];
      let beatCount = 0;
      parsed.episodes.forEach((ep, epIndex) => {
        const episode = createEpisode(
          { no: baseNo + epIndex + 1, title: ep.title, summary: ep.summary, targetSeconds: secondsPerEpisode },
          clock,
        );
        episodes.push(episode);
        createdEpisodes.push({ id: episode.id, no: episode.no, title: episode.title, summary: episode.summary, sceneCount: ep.scenes.length });
        ep.scenes.forEach((scene, sceneIndex) => {
          const beats = scene.beats.map((beat, beatIndex) => {
            const beatId = `beat-${stamp}-${createdEpisodes.length}-${sceneIndex}-${beatIndex}`;
            const item = {
              id: beatId,
              // 模型给的 kind 优先：文字段落/画面/视频的分工是改编结果本身
              kind: ['novel', 'image', 'video'].includes(beat.kind) ? beat.kind : (stampRecipe?.kind || 'image'),
              prompt: beat.prompt,
              ...(beat.dialogue ? { dialogue: String(beat.dialogue).slice(0, 2000) } : {}),
              // 与"一键分镜"同一条规则：镜头语言字段与时长要落到段落上（供编译器使用）
              ...(beat.shot && Object.keys(beat.shot).length ? { shot: beat.shot } : {}),
              ...(beat.params?.seconds ? { params: { ...(beat.params || {}) } } : {}),
              ...(stampRecipe?.negative ? { negative: stampRecipe.negative } : {}),
              references: pickBeatReferences(cast, beat.prompt),
              ...(previousId ? { inheritFromBeatId: previousId } : {}),
            };
            previousId = beatId;
            beatCount += 1;
            return item;
          });
          const sceneId = `scene-${stamp}-${createdEpisodes.length}-${sceneIndex}`;
          createdSceneIds.push(sceneId);
          scenes.push({
            id: sceneId, index: scenes.length + 1, episodeId: episode.id,
            title: scene.title || `第 ${scenes.length + 1} 场`, summary: scene.summary,
            ...(scene.slug ? { slug: scene.slug } : {}),
            beats, outputs: [],
          });
        });
      });
      const record = {
        id: `adapt-${(clock.id || makeId)()}`,
        at: (clock.now || nowIso)(),
        source: { ...sourceBrief, chapters: sourceBrief.chapters.map(c => ({ file: c.file, title: c.title, chars: c.chars })) },
        episodeIds: createdEpisodes.map(e => e.id),
        sceneIds: createdSceneIds,
        episodeCount: createdEpisodes.length, sceneCount: createdSceneIds.length, beatCount,
        logline: parsed.overview.logline,
        relationships: parsed.overview.relationships,
        model: { provider: model?.provider || '', id: model?.id || '' },
      };
      const next = withUpdated({
        ...project,
        bible,
        ...(parsed.overview.logline && !String(project.logline || '').trim() ? { logline: parsed.overview.logline } : {}),
        episodes: normalizeEpisodes(episodes),
        scenes,
        // 改编史留档：刷新之后仍要能回答"这个项目是从哪本小说、哪几章改出来的"
        adaptations: [...(project.adaptations || []), record].slice(-10),
      });
      validateProject(next);
      await writeProject(root, next);
      return {
        project: next, source: sourceBrief, adaptations: next.adaptations,
        episodeCount: createdEpisodes.length, sceneCount: createdSceneIds.length, beatCount,
        episodesCreated: createdEpisodes, episodeIds: record.episodeIds, sceneIds: createdSceneIds,
        overview: parsed.overview,
        characters: cast.length, characterNames: cast.map(c => String(c.name || '')).filter(Boolean),
        model: record.model, requested: episodeWish, attempts, retried,
        ...(firstEpisodes && firstEpisodes !== createdEpisodes.length ? { firstEpisodeCount: firstEpisodes } : {}),
        ...(parsed.failures.length ? { incomplete: parsed.failures.slice(0, 8) } : {}),
        ...(createdEpisodes.length < episodeWish
          ? { short: true, note: `模型两次一共只给了 ${createdEpisodes.length} 集（要的是 ${episodeWish} 集），可以再点一次或把改编要求写具体些` }
          : {}),
      };
    },
    // 合成前的候选清单（只读）：每段有哪些版本能进片子、各自什么状态。
    // 用户常常同一段生成好几版镜头，只让他"按分镜顺序自动拼"等于把挑片子的权利拿走了。
    // durations=true 才会去探每一版的时长（要 spawn ffprobe）。别默认开：
    // 打开面板就得等它，而不带时长的清单本来就是老行为——时间轴要合计时长时才多这一步。
    filmPlan: async (id, opts = {}) => {
      const project = await readProject(root, id);
      return opts.durations ? filmPlanWithDurations(project, root) : filmPlan(project, root);
    },
    // 成片合成：按分镜顺序把**成功**的视频片段拼成一条长片，并落盘为正式产物。
    // 界面此前明确写着「暂不自动拼成长片」，这里把它做掉。
    //
    // 2026-09-16 补「挑版本」：`clips: [{ beatId, runId }]` 指定**每一段用哪一版、什么顺序**；
    // 不传就退回原行为（每段取最后一次成功、按分镜顺序）。挑不出来的段不静默丢掉——
    // 逐条进 skipped 回报（下载不下来 / 这一版已被删除 / 这一版不属于这一段）。
    assembleFilm: async (id, input = {}) => {
      const project = await readProject(root, id);
      const { clips, skipped, localized } = await prepareFilmClips(project, input);
      if (!clips.length) {
        const why = skipped.map(s => s.reason).join('；');
        // "挑过的"和"没挑的"要用不同的话：挑了却一段都拼不了，跟"还没有视频可拼"是两回事
        const message = Array.isArray(input.clips)
          ? `挑出来的片段一个都拼不了：${why || '你一段都没选'}`
          : (skipped.length ? `没有可合成的片段：${why}` : '还没有成功的视频片段可合成：先在某个段落里生成视频');
        throw Object.assign(new Error(message), { statusCode: 400, skipped });
      }
      if (typeof saveArtifactFromFile !== 'function') throw Object.assign(new Error('产物入库未接入'), { statusCode: 503 });
      // 外链已经下载到本地了：把地址**写回项目**。否则下次合成又要重下一遍，
      // 而且界面上会一直挂着一条"没落到本地"的旧状态（契约要求落盘，不是每次现下）。
      const withLocalized = localized.length
        ? {
          ...project,
          scenes: project.scenes.map(scene => ({
            ...scene,
            outputs: (scene.outputs || []).map(run => {
              const hit = localized.find(l => l.runId === run.id);
              if (!hit) return run;
              const next = {
                ...run,
                outputAssets: (run.outputAssets || []).map(a => (String(a.url) === hit.from ? { ...a, url: hit.url } : a)),
              };
              // 落盘成功了，就把"没能存到本地"那条降级说明去掉——留着它就是在说假话
              if (Array.isArray(next.degradation)) {
                const left = next.degradation.filter(d => !/本地|localize/i.test(String(d)));
                if (left.length !== next.degradation.length) { if (left.length) next.degradation = left; else delete next.degradation; }
              }
              return next;
            }),
          })),
        }
        : project;
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'story-film-'));
      try {
        const outFile = path.join(dir, 'film.mp4');
        const result = await concatClips({ clips, outFile, workDir: dir });
        const url = await saveArtifactFromFile({ filePath: result.outFile, type: 'video', prompt: `${project.title} 成片 ${result.clipCount} 段` });
        const film = {
          id: `film-${(clock.id || makeId)()}`,
          url,
          clipCount: result.clipCount,
          method: result.method,
          // 记下这一版成片用了哪些段：重排分镜后仍能还原"这版成片是什么时候、由哪些片段拼的"
          beatIds: clips.map(c => c.beatId),
          // 挑版本时还要记住**用的是哪一版**：否则事后分不清这版成片用的是第 2 版还是第 5 版的镜头
          ...(input.clips ? { picks: clips.map(c => ({ beatId: c.beatId, runId: c.runId })) } : {}),
          // 这一版成片里有几段是从外链**现下载**到本地的：事后能看出"这些片段当时还是临时链接"
          ...(localized.length ? { localized: localized.map(l => ({ beatId: l.beatId, runId: l.runId })) } : {}),
          createdAt: (clock.now || nowIso)(),
        };
        const next = withUpdated({ ...withLocalized, films: [...(withLocalized.films || []), film] });
        await writeProject(root, next);
        return { project: next, film, url, clipCount: result.clipCount, method: result.method, beatIds: film.beatIds, skipped, localized };
      } finally {
        try { await fsp.rm(dir, { recursive: true, force: true }); } catch {}
      }
    },
    // 全项目补下载：把还挂在外站的东西一次搞到本地。
    // 覆盖两类，因为它们是同一件事的两副面孔：
    //   refs —— 定妆照 / 场景参考图 / 道具参考图（写回 bible 对应条目）
    //   runs —— 每一次生成的产出（写回 run.outputAssets）
    // 只补下载、**不重新生成**：产物还在，只是没落到本地，重生成要多花一次钱。
    // 挂载素材（beat.inputs）刻意不动：它是"引用别的工作台的产物"，再落一份盘只是重复占地方，
    // 这一点在返回里明确说出来（skipped），不装作没看见。
    localizeProject: async (id, input = {}) => {
      const project = await readProject(root, id);
      const scope = input.scope === 'refs' || input.scope === 'runs' ? input.scope : 'all';
      const items = [];
      const applyRefs = [];
      const applyRuns = new Map();
      // ① 参考图
      if (scope !== 'runs') {
        for (const [key, kind] of Object.entries(BIBLE_ASSET_KEYS)) {
          for (const item of Array.isArray(project.bible?.[key]) ? project.bible[key] : []) {
            const url = String(item?.refImage || '');
            if (!/^(https?:|data:)/i.test(url)) continue;
            const got = await pullToLocal(url, { type: 'image', prompt: `${kind} 参考图`, root, saveArtifact });
            items.push({ kind: 'ref', assetType: kind, itemId: item.id, label: item.name || item.id, from: url, ...got });
            if (got.ok && !got.alreadyLocal) applyRefs.push({ key, itemId: item.id, url: got.url });
          }
        }
      }
      // ② 运行产出
      if (scope !== 'refs') {
        for (const scene of project.scenes || []) {
          for (const run of scene.outputs || []) {
            for (const asset of run.outputAssets || []) {
              const url = String(asset?.url || '');
              if (!/^(https?:|data:)/i.test(url)) continue;
              const got = await pullToLocal(url, { type: asset.type || 'image', prompt: run.promptText || `${run.beatId || ''} 产物`, root, saveArtifact });
              items.push({ kind: 'run', sceneId: scene.id, runId: run.id, beatId: run.beatId, assetId: asset.id, from: url, ...got });
              if (got.ok && !got.alreadyLocal) {
                const list = applyRuns.get(run.id) || [];
                list.push({ assetId: asset.id, from: url, url: got.url });
                applyRuns.set(run.id, list);
              }
            }
          }
        }
      }
      const done = items.filter(i => i.ok && !i.alreadyLocal);
      const failed = items.filter(i => !i.ok);
      let next = project;
      if (done.length) {
        next = withUpdated({
          ...project,
          bible: applyRefs.length
            ? Object.fromEntries(Object.entries(project.bible || {}).map(([key, list]) => [key, (Array.isArray(list) ? list : []).map(item => {
              const hit = applyRefs.find(r => r.key === key && String(r.itemId) === String(item.id));
              return hit ? { ...item, refImage: hit.url } : item;
            })]))
            : project.bible,
          scenes: project.scenes.map(scene => ({
            ...scene,
            outputs: (scene.outputs || []).map(run => {
              const hits = applyRuns.get(run.id);
              if (!hits) return run;
              const updated = { ...run, outputAssets: (run.outputAssets || []).map(a => {
                const hit = hits.find(h => String(h.assetId) === String(a.id) || h.from === String(a.url));
                return hit ? { ...a, url: hit.url } : a;
              }) };
              // 全下完了才清"没落到本地"那条说明；还有没下的就得留着
              const stillExternal = (updated.outputAssets || []).some(a => /^https?:/i.test(String(a.url || '')));
              if (!stillExternal && Array.isArray(updated.degradation)) {
                const left = updated.degradation.filter(d => !/本地|localize/i.test(String(d)));
                if (left.length !== updated.degradation.length) { if (left.length) updated.degradation = left; else delete updated.degradation; }
              }
              return updated;
            }),
          })),
        });
        validateProject(next);
        await writeProject(root, next);
      }
      return {
        project: next,
        scope,
        localized: done.length,
        failed: failed.length,
        items,
        // 挂载素材是"引用别的工作台的产物"：再落一份盘只是重复占地方。
        // 不论扫哪个范围都不动它，但**必须说出来**——"没做"和"忘了做"看起来一样。
        skipped: (project.scenes || []).some(s => (s.beats || []).some(b => (b.inputs || []).some(i => /^https?:/i.test(String(i.url || '')))))
          ? [{ what: '段落挂载素材', reason: '挂载素材是引用别的工作台的产物，不再落一份盘（避免重复占地方）' }]
          : [],
      };
    },
    // 把某一版还挂在外站的产物**下载到本地**（本地化契约的重试入口）。
    // 为什么要有这个入口：入库时下载失败（上游 CDN 抖一下、502），项目里留下的就是外站临时链接——
    // 它是会自己死掉的引用，而此前除了"重新生成一次"（再花一次钱）没有任何补救办法。
    // 这里只补下载，不重新生成：产物还在，只是没落到本地。
    localizeRun: async (id, input = {}) => {
      const project = await readProject(root, id);
      const scene = findScene(project, input.sceneId);
      const run = (scene?.outputs || []).find(r => String(r.id) === String(input.runId));
      if (!scene || !run) throw Object.assign(new Error('sceneId 或 runId 不存在（可能已经被删掉了）'), { statusCode: 404 });
      if (typeof saveArtifact !== 'function') throw Object.assign(new Error('落盘实现未接入，下载不了'), { statusCode: 503 });
      const results = [];
      const assets = [];
      for (const asset of run.outputAssets || []) {
        const url = String(asset?.url || '');
        const got = await pullToLocal(url, { type: asset.type || 'image', prompt: run.promptText || `${run.beatId || ''} 产物`, root, saveArtifact });
        results.push({ url, ok: got.ok, ...(got.alreadyLocal ? { alreadyLocal: true } : {}), ...(got.ok && !got.alreadyLocal ? { saved: got.url } : {}), ...(got.ok ? {} : { reason: got.reason }) });
        assets.push(got.ok && !got.alreadyLocal ? { ...asset, url: got.url } : asset);
      }
      const okCount = results.filter(r => r.ok && !r.alreadyLocal).length;
      const failed = results.filter(r => !r.ok);
      const next = withUpdated({
        ...project,
        scenes: project.scenes.map(s => s.id !== scene.id ? s : {
          ...s,
          outputs: (s.outputs || []).map(r => {
            if (String(r.id) !== String(run.id)) return r;
            const updated = { ...r, outputAssets: assets };
            // 全部落下去了才把"没落到本地"那条降级说明去掉；还有没下去的就得留着
            if (!failed.length && Array.isArray(updated.degradation)) {
              const left = updated.degradation.filter(d => !/本地|localize/i.test(String(d)));
              if (left.length !== updated.degradation.length) { if (left.length) updated.degradation = left; else delete updated.degradation; }
            }
            return updated;
          }),
        }),
      });
      validateProject(next);
      await writeProject(root, next);
      return { project: next, run: next.scenes.find(s => s.id === scene.id).outputs.find(r => String(r.id) === String(run.id)), results, localized: okCount, failed: failed.length };
    },
    // ── 台词与深度构思（用户说"人物场景搭上了，对话和构思还是不行"）──
    // 台词体检：**纯机检、不花模型钱**，随用随看。语速/时长/拆镜这些本来就是能算的，
    // 以前却要花一次模型调用才能从"听起来别扭"里猜。
    dialogueAudit: async (id, input = {}) => {
      const project = await readProject(root, id);
      const scene = input.sceneId ? findScene(project, input.sceneId) : null;
      const targets = scene ? [scene] : (project.scenes || []);
      const scenes = targets.map(s => {
        const beats = (s.beats || []).map(b => {
          const dialogue = String(b.dialogue || '').trim();
          if (!dialogue) return null;
          const budgetSec = Number(b?.params?.seconds) > 0 ? Number(b.params.seconds) : null;
          return { beatId: b.id, beatKind: b.kind, budgetSec, audit: dialogueAudit({ dialogue, budgetSec, genre: String(project.genre || '') }) };
        }).filter(Boolean);
        return { sceneId: s.id, title: s.title || '', beats };
      }).filter(s => s.beats.length);
      const all = scenes.flatMap(s => s.beats.map(b => b.audit));
      return {
        scenes,
        totals: {
          beats: all.length,
          chars: all.reduce((n, a) => n + a.speech.chars, 0),
          warn: all.reduce((n, a) => n + a.issues.filter(i => i.level === 'warn').length, 0),
          info: all.reduce((n, a) => n + a.issues.filter(i => i.level === 'info').length, 0),
        },
        notes: CRAFT_NOTES,
      };
    },
    // 台词诊断与重构：**出草稿，不落盘**（人在界面上逐条决定采不采用）。
    // 机检结果一并喂给模型，逼它针对真问题改，而不是自由发挥一遍。
    dialogueDoctor: async (id, input = {}) => {
      const project = await readProject(root, id);
      const scene = findScene(project, input.sceneId) || (project.scenes || [])[0];
      if (!scene) throw Object.assign(new Error('这个项目还没有场景'), { statusCode: 400 });
      if (typeof directChat !== 'function') throw Object.assign(new Error('台词诊断引擎未接入'), { statusCode: 503 });
      const rows = (scene.beats || []).flatMap(b => parseDialogueLines(String(b.dialogue || '')).filter(r => r.type === 'dialogue'));
      if (!rows.length) throw Object.assign(new Error('这一场还没有台词：先在段落里写台词，或点「一键分镜」让它先出一版'), { statusCode: 400 });
      const dialogueText = rows.map(r => `${r.speaker}：${r.text}`).join('\n');
      const budgetSec = Number((scene.beats || []).find(b => Number(b?.params?.seconds) > 0)?.params?.seconds) || null;
      const audit = dialogueAudit({ dialogue: dialogueText, budgetSec, genre: String(project.genre || '') });
      const method = await methodOf(root, project.methodId);
      const model = pickJsonModel(input.model);
      const prompt = buildDialogueDoctorPrompt({
        scene, rows, audit, bible: project.bible || {}, genre: String(project.genre || ''),
        method: method ? `${method.name}：${method.goal || ''}` : null,
      });
      let lastError = '台词诊断模型没有返回内容';
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await directChat(model, attempt === 0 ? prompt : `${prompt}\n\n【补充要求】上一次你的回复无法解析。这一次**只输出那一个 JSON 对象**，不要解释、不要代码块。`, [], { maxTokens: 4000, timeout: 120000 });
        if (!result?.text) { lastError = '台词诊断模型没有返回内容'; continue; }
        try {
          const parsed = parseDialogueDoctor(result.text, extractJsonObjects);
          return { project, sceneId: scene.id, sceneTitle: scene.title || '', audit, doctor: parsed, model: { provider: model?.provider || '', id: model?.id || '' }, ...(attempt ? { retried: true } : {}) };
        } catch (error) {
          lastError = String(error?.message || error);
          console.log(`[story] 台词诊断解析失败（模型 ${model?.provider}/${model?.id}，第 ${attempt + 1} 次）：${String(result.text).replace(/\s+/g, ' ').slice(0, 800)}`);
        }
      }
      throw Object.assign(new Error(lastError), { statusCode: 502 });
    },
    // 深度构思：情绪契约 / 人物四件套 / 矛盾单元 / 分集地图 / 因果节拍 / 四账台账。
    // 同样**出草稿不落盘**；界面上确认后再 saveCraft 写进项目。
    storyEngine: async (id, input = {}) => {
      const project = await readProject(root, id);
      if (typeof directChat !== 'function') throw Object.assign(new Error('构思引擎未接入'), { statusCode: 503 });
      const model = pickJsonModel(input.model);
      const episodes = Math.max(0, Math.min(200, Number(input.episodes) || (project.episodes || []).length || 0));
      const prompt = buildStoryEnginePrompt({
        title: project.title, logline: project.logline,
        idea: String(input.idea || '').trim().slice(0, 2000),
        bible: project.bible || {}, episodes, genre: String(project.genre || ''),
        episodesPerUnit: Math.max(10, Math.min(40, Number(input.episodesPerUnit) || 25)),
      });
      let lastError = '构思模型没有返回内容';
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await directChat(model, attempt === 0 ? prompt : `${prompt}\n\n【补充要求】上一次你的回复无法解析。这一次**只输出那一个 JSON 对象**，不要解释、不要代码块。`, [], { maxTokens: 8000, timeout: 180000 });
        if (!result?.text) { lastError = '构思模型没有返回内容'; continue; }
        try {
          const engine = parseStoryEngine(result.text, extractJsonObjects);
          return { project, engine, audit: auditEngine(engine, { currentEpisode: (project.episodes || []).length, plannedEpisodes: episodes }), model: { provider: model?.provider || '', id: model?.id || '' }, ...(attempt ? { retried: true } : {}) };
        } catch (error) {
          lastError = String(error?.message || error);
          console.log(`[story] 深度构思解析失败（模型 ${model?.provider}/${model?.id}，第 ${attempt + 1} 次）：${String(result.text).replace(/\s+/g, ' ').slice(0, 800)}`);
        }
      }
      throw Object.assign(new Error(lastError), { statusCode: 502 });
    },
    // 构思体检（只读）：**已保存的构思也要能随时体检**。
    // 真机上踩到：面板只在"生成/保存"之后才算体检，于是打开一个已有构思的项目时，
    // 那条"伏笔没写回收集"安安静静地躺着——体检的价值就在于当下看得见。
    craftAudit: async (id, input = {}) => {
      const project = await readProject(root, id);
      const planned = Math.max(0, Number(input.plannedEpisodes) || (project.episodes || []).length || (project.craft?.episodeMap || []).length || 0);
      return { audit: auditEngine(project.craft, { currentEpisode: (project.episodes || []).length, plannedEpisodes: planned }), plannedEpisodes: planned, hasCraft: Boolean(project.craft) };
    },
    // 把确认过的构思写进项目（人在界面上看过之后才走到这里）
    saveCraft: async (id, input = {}) => {
      const project = await readProject(root, id);
      const engine = input.craft || input.engine;
      if (!engine || typeof engine !== 'object') throw Object.assign(new Error('没有要保存的构思内容'), { statusCode: 400 });
      const next = withUpdated({ ...project, craft: engine });
      validateProject(next);
      await writeProject(root, next);
      return { project: next, audit: auditEngine(engine, { currentEpisode: (project.episodes || []).length }) };
    },
    // 分集地图 → 真的建集（连同每集的目标与钩子写进集里）。
    // 这一步是"构思落到能干活的东西上"：地图不会自己变成集，用户点一下就该有。
    applyEpisodeMap: async (id, input = {}) => {
      const project = await readProject(root, id);
      const map = Array.isArray(input.episodeMap) ? input.episodeMap : (project.craft?.episodeMap || []);
      if (!map.length) throw Object.assign(new Error('还没有分集地图：先做一次深度构思'), { statusCode: 400 });
      const episodes = normalizeEpisodes(project.episodes);
      const created = [];
      for (const [i, item] of map.slice(0, 200).entries()) {
        const no = Number(item?.no) || i + 1;
        if (episodes.some(e => e.no === no)) continue; // 已存在的不覆盖：手工改过的集不该被地图冲掉
        const summary = [String(item?.goal || '').trim(), String(item?.hook || '').trim() ? `钩子：${String(item.hook).trim()}` : ''].filter(Boolean).join('｜');
        const episode = createEpisode({ no, title: `第 ${no} 集`, summary }, clock);
        episodes.push(episode);
        created.push(episode);
      }
      const next = withUpdated({ ...project, episodes: normalizeEpisodes(episodes) });
      validateProject(next);
      await writeProject(root, next);
      return { project: next, created, skipped: map.length - created.length };
    },
    // 删项目。比删一版产出严重得多（人物、分集、成片历史都在里面），所以：
    // 1) **一定先留副本**（story-projects/.trash/），手滑删掉整部戏是不可逆的；
    // 2) 产物文件默认**不动**——它们在工作区里还能从「资产」找到，而且可能被别的项目引用；
    //    真要一起清，得显式传 deleteFiles，且只删**没有被别处引用**的那些；
    // 3) 如实回报删了什么、留了什么、副本在哪。
    deleteProject: async (id, input = {}) => {
      const project = await readProject(root, id);
      const urls = [...new Set(urlsInProject(project))];
      // 先把项目记录挪进 .trash（这一步之后它就不再出现在项目列表里，
      // 也不会被 referencedElsewhere 当成"还在用这个文件"——.trash 是子目录，不在扫描范围内）。
      const moved = await trashProject(root, id);
      const files = [];
      if (input.deleteFiles) {
        for (const url of urls) {
          const file = localPathFromArtifactUrl(url, root);
          if (!file || !(await fileExists(file))) continue;
          const referenced = await referencedElsewhere(root, file);
          if (referenced) { files.push({ url, deleted: false, reason: `还被「${referenced}」引用，只移除项目记录` }); continue; }
          try { await fsp.rm(file, { force: true }); files.push({ url, deleted: true }); }
          catch (error) { files.push({ url, deleted: false, reason: `删除文件失败：${String(error?.message || error).slice(0, 80)}` }); }
        }
      }
      return {
        deletedProjectId: id, title: project.title,
        trashCopy: moved.kept,
        files,
        fileDeleted: files.filter(f => f.deleted).length,
        fileKept: files.filter(f => !f.deleted).length,
        note: input.deleteFiles
          ? '项目已移除；产物文件按"没有被别处引用"的规则清理，副本留在 story-projects/.trash/。'
          : '项目已移除；产物文件**没有动**（还在工作区里，可从「资产」找到）。副本留在 story-projects/.trash/，改回来即可恢复。',
      };
    },
    // 删掉某一版产出（以及它的文件）。
    // 用户会同一段生成好几版镜头，留着占地方、挑片子时也碍眼——但**删是不可逆的**，
    // 所以三件事必须做对：
    // 1) 文件还被别处引用（别的运行/设定里的参考图/别段挂的素材）时**不删文件**，只移除记录并说明；
    // 2) 还在排队的版本默认不删（上游那个任务我们还在等，删了记录就永远收不回来了），要删得明说 force；
    // 3) 外链（http/data）永远不碰本地磁盘。
    deleteRun: async (id, input = {}) => {
      const project = await readProject(root, id);
      const scene = findScene(project, input.sceneId);
      const run = (scene?.outputs || []).find(r => String(r.id) === String(input.runId));
      if (!scene || !run) throw Object.assign(new Error('sceneId 或 runId 不存在（可能已经被删掉了）'), { statusCode: 404 });
      if (run.status === 'running' && !input.force) {
        throw Object.assign(new Error(`这一版还在排队（任务号 ${String(run.taskId || '无').slice(0, 14)}）。先「查一次」把它收尾，或点「强制删除」——删掉之后上游出的片子就再也收不回来了。`), { statusCode: 409 });
      }
      const urls = (run.outputAssets || []).map(a => String(a.url || '')).filter(Boolean);
      const nextScene = { ...scene, outputs: (scene.outputs || []).filter(r => String(r.id) !== String(run.id)) };
      if (String(nextScene.activeRunId || '') === String(run.id)) delete nextScene.activeRunId;
      const next = withUpdated({ ...project, scenes: project.scenes.map(s => s.id === scene.id ? nextScene : s) });
      validateProject(next);
      // 先落盘再删文件：万一删文件这一步出错，至少记录已经是"已移除"，
      // 不会留下一条指向空文件的运行（那种状态比"文件还在"难查得多）。
      await writeProject(root, next);

      const fileResults = [];
      if (input.keepFiles === true) {
        for (const url of urls) fileResults.push({ url, deleted: false, reason: '你选了只移除记录、保留文件' });
      } else {
        for (const url of urls) {
          const file = localPathFromArtifactUrl(url, root);
          if (!file) { fileResults.push({ url, deleted: false, reason: '不是本地文件（外链或数据），不碰磁盘' }); continue; }
          // 生成物目录是共享的：同一个文件可能仍被**别的项目**引用。
          // 只在本项目里查就会把别人还指着的那张图删掉——所以扫全部项目文件（本项目已写成不含它的样子）。
          const referenced = await referencedElsewhere(root, file);
          if (referenced) { fileResults.push({ url, deleted: false, reason: `同一个文件还被「${referenced}」引用，只移除记录、保留文件` }); continue; }
          try { await fsp.rm(file, { force: true }); fileResults.push({ url, deleted: true }); }
          catch (error) { fileResults.push({ url, deleted: false, reason: `删除文件失败：${String(error?.message || error).slice(0, 80)}` }); }
        }
      }
      return {
        project: next, deletedRunId: run.id, kind: run.kind, status: run.status,
        files: fileResults,
        fileDeleted: fileResults.filter(f => f.deleted).length,
        fileKept: fileResults.filter(f => !f.deleted).length,
        remaining: nextScene.outputs.filter(r => r.beatId === run.beatId).length,
      };
    },
  };
}

// 一个项目里所有"指向文件"的地址：运行产出、段落挂的素材、设定里的参考图、成片。
// 删文件前用它来判断"这个文件还有没有人要"。
function urlsInProject(project) {
  const urls = [];
  for (const scene of project?.scenes || []) {
    for (const run of scene?.outputs || []) for (const asset of run?.outputAssets || []) if (asset?.url) urls.push(String(asset.url));
    for (const beat of scene?.beats || []) for (const input of beat?.inputs || []) if (input?.url) urls.push(String(input.url));
  }
  for (const key of ['characters', 'locations', 'props', 'wardrobe']) {
    for (const item of project?.bible?.[key] || []) if (item?.refImage) urls.push(String(item.refImage));
  }
  for (const film of project?.films || []) if (film?.url) urls.push(String(film.url));
  return urls;
}

// 这个文件是不是还被别的项目引用（生成物目录是所有项目共享的）。
// 返回引用它的项目文件名（不含扩展名），没有就返回空串。
// 为什么值得扫全部项目：只查当前项目，就会在别的项目还指着这张图的时候把它删掉——
// 那是用户**没法恢复**的损失，宁可留着文件（几 MB）也不要删错。
async function referencedElsewhere(root, file) {
  const target = String(file).replace(/\\/g, '/').toLowerCase();
  const dir = path.join(root, 'story-projects');
  let names = [];
  try { names = (await fsp.readdir(dir)).filter(n => n.endsWith('.json')); } catch { return ''; }
  for (const name of names) {
    let project = null;
    try { project = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8')); } catch { continue; }
    // 成片文件与素材文件也在同一套判断里：宁可多留，不可删错
    for (const url of urlsInProject(project)) {
      if (!url) continue;
      const path0 = localPathFromArtifactUrl(url, root);
      if (path0 && path0.replace(/\\/g, '/').toLowerCase() === target) return name.replace(/\.json$/, '');
    }
  }
  return '';
}

function bodyOrEmpty(body) { return body && typeof body === 'object' ? body : {}; }
function sendError(res, error) { const status = Number(error?.statusCode) || (error?.code === 'ENOENT' ? 404 : 400); return json(res, status, { error: String(error?.message || error) }); }

export async function handleStoryProjects(ctx, res, body) {
  try {
    const api = createStoryOrchestrator(ctx);
    // 列表也带 flow：界面打开时是**先拉列表再选项目**的（不是逐个拉详情），
    // 只在详情里给 flow，状态条在首屏就是空的——真机验收时正是这么发现的。
    // flow 是纯函数算出来的，给整列加上不产生额外 IO。
    if (body === undefined) {
      const projects = await api.list();
      return json(res, 200, { projects: projects.map(p => ({ ...p, flow: storyFlow(p) })) });
    }
    return json(res, 201, { project: await api.create(bodyOrEmpty(body)) });
  } catch (e) { return sendError(res, e); }
}

export async function handleStoryProject(ctx, res, id) {
  try {
    const project = await createStoryOrchestrator(ctx).get(id);
    // 状态机随项目一起下发（不落盘，是算出来的）：界面照它渲染"现在能干什么、为什么不能"。
    return json(res, 200, { project: { ...project, flow: storyFlow(project) } });
  } catch (e) { return sendError(res, e); }
}

export async function handleStoryProjectDelete(ctx, res, id, body) {
  try { return json(res, 200, await createStoryOrchestrator(ctx).deleteProject(id, bodyOrEmpty(body))); } catch (e) { return sendError(res, e); }
}

export async function handleStoryProjectPatch(ctx, res, id, body) {
  try { return json(res, 200, { project: await createStoryOrchestrator(ctx).patch(id, bodyOrEmpty(body)) }); } catch (e) { return sendError(res, e); }
}

export async function handleStoryRunPreview(ctx, res, id, body) {
  try { return json(res, 200, await createStoryOrchestrator(ctx).previewRun(id, bodyOrEmpty(body))); } catch (e) { return sendError(res, e); }
}

export async function handleStoryRun(ctx, res, id, body) {
  try {
    return json(res, 200, await createStoryOrchestrator(ctx).runGeneration(id, bodyOrEmpty(body)));
  } catch (e) { return sendError(res, e); }
}

export async function handleStoryRunCheck(ctx, res, id, body) {
  try { return json(res, 200, await createStoryOrchestrator(ctx).checkRun(id, bodyOrEmpty(body))); } catch (e) { return sendError(res, e); }
}

export async function handleStoryRunCheckMany(ctx, res, id, body) {
  try { return json(res, 200, await createStoryOrchestrator(ctx).checkRuns(id, bodyOrEmpty(body))); } catch (e) { return sendError(res, e); }
}

export async function handleStoryEpisodes(ctx, res, id) {
  try { return json(res, 200, await createStoryOrchestrator(ctx).episodes(id)); } catch (e) { return sendError(res, e); }
}

export async function handleStoryEpisodeAdd(ctx, res, id, body) {
  try { return json(res, 201, await createStoryOrchestrator(ctx).addEpisode(id, bodyOrEmpty(body))); } catch (e) { return sendError(res, e); }
}

export async function handleStoryEpisodeUpdate(ctx, res, id, body) {
  try { return json(res, 200, await createStoryOrchestrator(ctx).updateEpisode(id, bodyOrEmpty(body))); } catch (e) { return sendError(res, e); }
}

export async function handleStoryEpisodeRemove(ctx, res, id, body) {
  try { return json(res, 200, await createStoryOrchestrator(ctx).removeEpisode(id, bodyOrEmpty(body))); } catch (e) { return sendError(res, e); }
}

export async function handleStorySceneAssign(ctx, res, id, body) {
  try { return json(res, 200, await createStoryOrchestrator(ctx).assignScene(id, bodyOrEmpty(body))); } catch (e) { return sendError(res, e); }
}

export async function handleStoryScriptStats(ctx, res, id) {
  try { return json(res, 200, await createStoryOrchestrator(ctx).scriptStats(id)); } catch (e) { return sendError(res, e); }
}

export async function handleStoryExportScript(ctx, res, id, body) {
  try { return json(res, 200, await createStoryOrchestrator(ctx).exportScript(id, bodyOrEmpty(body))); } catch (e) { return sendError(res, e); }
}

export async function handleStoryPlayground(ctx, res, id, body) {
  try { return json(res, 200, await createStoryOrchestrator(ctx).playground(id, bodyOrEmpty(body))); } catch (e) { return sendError(res, e); }
}

export async function handleStoryPlaygroundClear(ctx, res, id, body) {
  try { return json(res, 200, await createStoryOrchestrator(ctx).clearPlayground(id, bodyOrEmpty(body))); } catch (e) { return sendError(res, e); }
}

export async function handleStoryPortrait(ctx, res, id, body) {
  try {
    return json(res, 200, await createStoryOrchestrator(ctx).generatePortrait(id, bodyOrEmpty(body)));
  } catch (e) { return sendError(res, e); }
}

export async function handleStoryAssetRef(ctx, res, id, body) {
  try { return json(res, 200, await createStoryOrchestrator(ctx).generateAssetRef(id, bodyOrEmpty(body))); } catch (e) { return sendError(res, e); }
}

export async function handleStoryLint(ctx, res, id, body) {
  try { return json(res, 200, await createStoryOrchestrator(ctx).lint(id, bodyOrEmpty(body))); } catch (e) { return sendError(res, e); }
}

export async function handleStoryStoryboard(ctx, res, id, body) {
  try { return json(res, 200, await createStoryOrchestrator(ctx).storyboard(id, bodyOrEmpty(body))); } catch (e) { return sendError(res, e); }
}

export async function handleStoryAdapt(ctx, res, id, body) {
  try { return json(res, 200, await createStoryOrchestrator(ctx).adapt(id, bodyOrEmpty(body))); } catch (e) { return sendError(res, e); }
}

export async function handleStoryMethods(ctx, res, body) {
  try {
    const api = createStoryOrchestrator(ctx);
    if (body === undefined) return json(res, 200, { methods: await api.methods() });
    return json(res, 201, await api.saveMethod(bodyOrEmpty(body)));
  } catch (e) { return sendError(res, e); }
}

export async function handleStoryMethodDelete(ctx, res, id) {
  try {
    const r = await createStoryOrchestrator(ctx).deleteMethod(id);
    return json(res, r.ok ? 200 : 404, r);
  } catch (e) { return sendError(res, e); }
}

export async function handleStoryMethodCapture(ctx, res, id, body) {
  try { return json(res, 201, await createStoryOrchestrator(ctx).captureMethod(id, bodyOrEmpty(body))); } catch (e) { return sendError(res, e); }
}

export async function handleStoryMethodApply(ctx, res, id, body) {
  try { return json(res, 200, await createStoryOrchestrator(ctx).applyMethod(id, bodyOrEmpty(body))); } catch (e) { return sendError(res, e); }
}

export async function handleStoryFilm(ctx, res, id, body) {
  try { return json(res, 200, await createStoryOrchestrator(ctx).assembleFilm(id, bodyOrEmpty(body))); } catch (e) { return sendError(res, e); }
}

export async function handleStoryFilmPlan(ctx, res, id, opts = {}) {
  try { return json(res, 200, await createStoryOrchestrator(ctx).filmPlan(id, opts)); } catch (e) { return sendError(res, e); }
}

// ── 台词与深度构思 ──
export async function handleStoryDialogueAudit(ctx, res, id, body) {
  try { return json(res, 200, await createStoryOrchestrator(ctx).dialogueAudit(id, bodyOrEmpty(body))); } catch (e) { return sendError(res, e); }
}

export async function handleStoryDialogueDoctor(ctx, res, id, body) {
  try { return json(res, 200, await createStoryOrchestrator(ctx).dialogueDoctor(id, bodyOrEmpty(body))); } catch (e) { return sendError(res, e); }
}

export async function handleStoryEngine(ctx, res, id, body) {
  try { return json(res, 200, await createStoryOrchestrator(ctx).storyEngine(id, bodyOrEmpty(body))); } catch (e) { return sendError(res, e); }
}

export async function handleStoryCraftSave(ctx, res, id, body) {
  try { return json(res, 200, await createStoryOrchestrator(ctx).saveCraft(id, bodyOrEmpty(body))); } catch (e) { return sendError(res, e); }
}

export async function handleStoryCraftAudit(ctx, res, id, body) {
  try { return json(res, 200, await createStoryOrchestrator(ctx).craftAudit(id, bodyOrEmpty(body))); } catch (e) { return sendError(res, e); }
}

export async function handleStoryEpisodeMapApply(ctx, res, id, body) {
  try { return json(res, 200, await createStoryOrchestrator(ctx).applyEpisodeMap(id, bodyOrEmpty(body))); } catch (e) { return sendError(res, e); }
}

export async function handleStoryRunDelete(ctx, res, id, body) {
  try { return json(res, 200, await createStoryOrchestrator(ctx).deleteRun(id, bodyOrEmpty(body))); } catch (e) { return sendError(res, e); }
}

export async function handleStoryRunLocalize(ctx, res, id, body) {
  try { return json(res, 200, await createStoryOrchestrator(ctx).localizeRun(id, bodyOrEmpty(body))); } catch (e) { return sendError(res, e); }
}

export async function handleStoryLocalizeAll(ctx, res, id, body) {
  try { return json(res, 200, await createStoryOrchestrator(ctx).localizeProject(id, bodyOrEmpty(body))); } catch (e) { return sendError(res, e); }
}

export async function handleStoryRecipes(ctx, res, body) {
  try {
    if (body === undefined) return json(res, 200, { recipes: await listRecipes(ctx.root) });
    const saved = await saveRecipe(ctx.root, bodyOrEmpty(body));
    return json(res, 201, saved);
  } catch (e) { return sendError(res, e); }
}

export async function handleStoryRecipeDelete(ctx, res, id) {
  try {
    const r = await deleteRecipe(ctx.root, id);
    return json(res, r.ok ? 200 : 404, r);
  } catch (e) { return sendError(res, e); }
}

export async function handleStoryRecipesExport(ctx, res) {
  try {
    const all = await listRecipes(ctx.root);
    // 导出的是**自足**的一份文件：换成别的机器/别人，导入即可用
    return json(res, 200, exportRecipes(all, (ctx && ctx.clock) || {}));
  } catch (e) { return sendError(res, e); }
}

export async function handleStoryRecipesImport(ctx, res, body) {
  try { return json(res, 200, await importRecipes(ctx.root, body)); } catch (e) { return sendError(res, e); }
}

export async function handleStoryAssist(ctx, res, id, body) {
  try {
    if (typeof ctx.directChat !== 'function' || typeof ctx.getDefaultModel !== 'function') throw Object.assign(new Error('智能填充引擎未接入'), { statusCode: 503 });
    const project = await readProject(ctx.root, id);
    const idea = String(bodyOrEmpty(body).idea || '').trim().slice(0, 2000);
    if (!idea) throw Object.assign(new Error('请输入想补充的故事想法'), { statusCode: 400 });
    const requested = body?.model?.id && body.model.id !== 'auto' ? body.model : null;
    const available = typeof ctx.getModelList === 'function' ? ctx.getModelList() : [];
    const fast = available.find(m => m?.capabilities?.chat && !m.reasoning && /agnes-3\.0-flash/i.test(m.id))
      || available.find(m => m?.capabilities?.chat && !m.reasoning)
      || ctx.getDefaultModel();
    const candidates = [requested, fast, ctx.getDefaultModel()].filter((m, i, all) => m?.id && all.findIndex(x => x?.provider === m.provider && x?.id === m.id) === i);
    const basePrompt = buildStoryAssistPrompt({ title: project.title, logline: project.logline, idea, current: project.bible });
    // 解析失败**先让同一个模型再答一次**（把"只输出 JSON"说到不能再直白），再换备选模型。
    // 用户看到的「智能填充返回的内容不是有效 JSON」十有八九就是模型多写了一句开场白——
    // 换模型是最后手段，不是第一反应（换模型往往还更慢更贵）。
    const strictPrompt = `${basePrompt}\n\n【补充要求】上一次你的回复无法解析。这一次**只输出那一个 JSON 对象**：不要解释、不要开场白、不要说"好的"、不要 Markdown 代码块、不要在 JSON 前后写任何字。`;
    let lastError = '智能填充模型没有返回内容';
    for (const model of candidates.slice(0, 2)) {
      for (let attempt = 0; attempt < 2; attempt++) {
        let result = null;
        try {
          result = await ctx.directChat(model, attempt === 0 ? basePrompt : strictPrompt, [], { maxTokens: 2200, timeout: 40000 });
        } catch (error) {
          lastError = String(error?.message || error);
          break;
        }
        if (!result?.text) { lastError = `${model.provider}/${model.id} 没有返回内容`; break; }
        try {
          return json(res, 200, { assist: parseStoryAssist(result.text), model: { provider: model.provider || '', id: model.id || '' }, ...(attempt ? { retried: true } : {}) });
        } catch (error) {
          lastError = String(error?.message || error);
          // 原文留在服务端日志里：不然只能看到"解析不出来"，无从判断是形状不符还是模型跑偏
          console.log(`[story] 智能填充解析失败（模型 ${model.provider}/${model.id}，第 ${attempt + 1} 次，原文 ${String(result.text).length} 字）：${String(result.text).replace(/\s+/g, ' ').slice(0, 1200)}`);
        }
      }
    }
    throw Object.assign(new Error(lastError), { statusCode: 502 });
  } catch (e) { return sendError(res, e); }
}
