// ===== story/handlers.mjs —— 故事工坊的 HTTP 处理器（2026-11-06 从 orchestrator.mjs 抽出）=====
//
// 这一层只做三件事：解析 body、调 orchestrator、把结果或错误写回响应。
// 业务全在 orchestrator.mjs 里，所以它们薄得可以直接读。
import { json } from "../http-utils.mjs";
import { createStoryOrchestrator } from "./orchestrator.mjs";
import { readProject } from "./store.mjs";
import { storyFlow } from "./flow.mjs";
import { buildStoryAssistPrompt, parseStoryAssist } from "./assist.mjs";
import { storyTextCandidates } from "./models.mjs";

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
    const candidates = storyTextCandidates({ explicit: body?.model, getModelList: ctx.getModelList, getDefaultModel: ctx.getDefaultModel });
    if (!candidates.length) throw Object.assign(new Error('没有可用的文本模型，请先到模型管理配置'), { statusCode: 503 });
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
