// engine/story-episodes.mjs —— 分集（集）这一层
//
// 对照两个同类产品时最明显的一条：**短剧/系列内容是以"集"为组织单位的**。
// PINNGOO 有"小说转分集短剧"（按原著体量与单集时长规划集数、按集查看调整镜头、生成前可改单集），
// LibTV 按集拆分镜头。而元枢此前只有「场」——做短剧时手里是一堆平铺的场，没有"第 3 集"这个概念，
// 于是"这一集多长""这一集里有哪些场""这一集的进度"都无从回答。
//
// 三条刻意的设计：
// 1. **集是项目上的独立实体**（`project.episodes`），场用 `scene.episodeId` 归属；
//    不把集信息塞进每个场里——那样改一次集标题要改 N 个场，必然漂移。
// 2. **允许"未分集"**：没分集的场照旧能用（单集短片、临时草稿），不会被强行塞进某一集。
// 3. 删除集**不删场**：场回到"未分集"，绝不因为删了一个集就把内容一起带走。

export const EPISODE_MAX = 200;
const makeId = () => `ep-${Math.random().toString(36).slice(2, 10)}`;

// 标题里已经写了「第 N 集」就不再存一遍：界面和三种剧本导出都会在前面加集号，
// 存进去会变成「第 1 集 · 第 1 集 · 站台」（2026-09-16 真机跑批量时界面就是这个）。
// 集号是独立字段，标题只该写"这一集叫什么"。
const EPISODE_PREFIX_RE = /^\s*第\s*\d+\s*集\s*[·:：\-—、.．]?\s*/;
export function cleanEpisodeTitle(title, no) {
  const raw = String(title || '').replace(EPISODE_PREFIX_RE, '').trim().slice(0, 60);
  return raw || `第 ${no} 集`;
}

export function normalizeEpisodes(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value.slice(0, EPISODE_MAX)) {
    if (!item || typeof item !== 'object') continue;
    const no = Number(item.no);
    const numbered = Number.isFinite(no) && no > 0 ? Math.round(no) : out.length + 1;
    out.push({
      id: String(item.id || makeId()),
      no: numbered,
      title: cleanEpisodeTitle(item.title, numbered),
      summary: String(item.summary || '').trim().slice(0, 600),
      // 目标时长（秒）：短剧按单集时长规划，有这个数才算"按目标排集"
      targetSeconds: Number.isFinite(Number(item.targetSeconds)) && Number(item.targetSeconds) > 0 ? Math.round(Number(item.targetSeconds)) : undefined,
      createdAt: item.createdAt ? String(item.createdAt) : undefined,
    });
  }
  return out.sort((a, b) => a.no - b.no);
}

export function nextEpisodeNo(episodes) {
  const list = normalizeEpisodes(episodes);
  return list.reduce((max, e) => Math.max(max, e.no), 0) + 1;
}

export function createEpisode(input = {}, clock = {}) {
  const now = (clock.now || (() => new Date().toISOString()))();
  const episodes = normalizeEpisodes(input.episodes);
  const no = Number.isFinite(Number(input.no)) && Number(input.no) > 0 ? Math.round(Number(input.no)) : nextEpisodeNo(episodes);
  return {
    id: String(input.id || (clock.id || makeId)()),
    no,
    title: cleanEpisodeTitle(input.title, no),
    summary: String(input.summary || '').trim().slice(0, 600),
    ...(Number.isFinite(Number(input.targetSeconds)) && Number(input.targetSeconds) > 0 ? { targetSeconds: Math.round(Number(input.targetSeconds)) } : {}),
    createdAt: now,
  };
}

// 按集给场分组。返回的第一个元素可能是"未分集"（episode 为 null），**始终排在最后**，
// 因为它是收尾不是开头。
export function groupScenesByEpisode(project) {
  const episodes = normalizeEpisodes(project?.episodes);
  const known = new Set(episodes.map(e => e.id));
  const groups = episodes.map(ep => ({ episode: ep, scenes: [] }));
  const loose = { episode: null, scenes: [] };
  for (const scene of project?.scenes || []) {
    const hit = scene?.episodeId && known.has(String(scene.episodeId)) ? groups.find(g => g.episode.id === String(scene.episodeId)) : null;
    (hit || loose).scenes.push(scene);
  }
  return groups.some(g => g.scenes.length) || !loose.scenes.length ? [...groups, loose].filter(g => g.scenes.length || g.episode) : [loose];
}

export function episodeOf(project, scene) {
  const id = scene?.episodeId;
  if (!id) return null;
  return normalizeEpisodes(project?.episodes).find(e => e.id === String(id)) || null;
}

// 一集的进度：场数 / 段数 / 已有成品的段数。界面与"批量生成"都用它，不各算一遍。
export function episodeStats(project, episodeId) {
  const scenes = (project?.scenes || []).filter(s => String(s?.episodeId || '') === String(episodeId || ''));
  let beats = 0, withOutput = 0, failed = 0, running = 0;
  for (const scene of scenes) {
    for (const beat of scene.beats || []) {
      beats += 1;
      const runs = (scene.outputs || []).filter(r => r.beatId === beat.id);
      if (runs.some(r => (r.outputAssets || []).length)) withOutput += 1;
      if (runs.some(r => r.status === 'failed')) failed += 1;
      if (runs.some(r => r.status === 'running')) running += 1;
    }
  }
  return { id: String(episodeId || ''), scenes: scenes.length, beats, withOutput, failed, running, pending: Math.max(0, beats - withOutput) };
}

// 把场指派到某一集（episodeId 传空 = 放回"未分集"）
export function assignSceneToEpisode(project, sceneId, episodeId) {
  const id = episodeId ? String(episodeId) : '';
  if (id && !normalizeEpisodes(project?.episodes).some(e => e.id === id)) {
    throw Object.assign(new Error('这一集不存在'), { statusCode: 400 });
  }
  let hit = false;
  const scenes = (project?.scenes || []).map(scene => {
    if (String(scene.id) !== String(sceneId)) return scene;
    hit = true;
    const next = { ...scene };
    if (id) next.episodeId = id; else delete next.episodeId;
    return next;
  });
  if (!hit) throw Object.assign(new Error('这一场不存在'), { statusCode: 404 });
  return { ...project, scenes };
}

// 删集：**只解绑，不删场**。删一个集就把内容一起带走，是最不能接受的一种"顺手"。
export function removeEpisode(project, episodeId) {
  const id = String(episodeId || '');
  const episodes = normalizeEpisodes(project?.episodes).filter(e => e.id !== id);
  if (episodes.length === normalizeEpisodes(project?.episodes).length) {
    throw Object.assign(new Error('这一集不存在'), { statusCode: 404 });
  }
  const scenes = (project?.scenes || []).map(scene => {
    if (String(scene?.episodeId || '') !== id) return scene;
    const next = { ...scene };
    delete next.episodeId;
    return next;
  });
  return { ...project, episodes, scenes, unassigned: scenes.filter(s => !s.episodeId).length };
}

// 重新编号：删掉中间某一集之后，让"第 N 集"重新连续。
export function renumberEpisodes(project) {
  const episodes = normalizeEpisodes(project?.episodes).map((e, i) => ({ ...e, no: i + 1 }));
  return { ...project, episodes };
}
