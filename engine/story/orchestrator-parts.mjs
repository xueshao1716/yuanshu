// engine/story/orchestrator-parts.mjs —— 编排器里可以独立出来的方法组（2026-11-06）
//
// createStoryOrchestrator 1322 行、45 个方法，全部共享同一批闭包状态，
// 一次性拆不现实。这里按「只依赖 root/clock/withUpdated」的组先抽，
// 不动主流程。
import { readProject, writeProject, validateProject } from "./store.mjs";
import { listRecipes, saveRecipe, deleteRecipe, importRecipes, exportRecipes } from "./recipes.mjs";
import {
  normalizeEpisodes, createEpisode, groupScenesByEpisode, episodeStats,
  assignSceneToEpisode, removeEpisode as removeEpisodeFromProject, renumberEpisodes,
} from "./episodes.mjs";

/** 配方：只依赖 root 与 clock。 */
export function storyRecipeMethods({ root, clock = {} }) {
  return {
    listRecipes: input => listRecipes(root, input || {}),
    saveRecipe: input => saveRecipe(root, input, clock),
    deleteRecipe: id => deleteRecipe(root, id),
    importRecipes: payload => importRecipes(root, payload, clock),
    exportRecipes: async (ids) => {
      const all = await listRecipes(root);
      const want = Array.isArray(ids) && ids.length ? all.filter(r => ids.includes(r.id)) : all;
      return exportRecipes(want, clock);
    },
  };
}

/** 分集：只依赖 root / clock / withUpdated。 */
export function storyEpisodeMethods({ root, clock = {}, withUpdated }) {
  return {
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
        ...(input.targetSeconds != null ? { targetSeconds: Number(input.targetSeconds) > 0 ? Math.round(Number(input.targetSeconds)) : e.targetSeconds } : {}),
      });
      const next = withUpdated({ ...project, episodes: normalizeEpisodes(episodes) });
      validateProject(next);
      await writeProject(root, next);
      return { project: next, episodes: next.episodes };
    },
    // 删集**只解绑，不删场**：删一个集就把内容一起带走，是最不能接受的一种"顺手"
    removeEpisode: async (id, input = {}) => {
      const project = await readProject(root, id);
      const stripped = removeEpisodeFromProject(project, input.episodeId);
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
  };
}
