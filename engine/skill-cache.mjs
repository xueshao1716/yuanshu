// ===== skill-cache.mjs —— 技能清单的单一来源 =====
//
// 2026-10-24 查出来的真问题：仓库里有两套技能系统，各扫各的根。
//   · 面板 `/api/skills`（engine/stats-api.mjs listSkills）：走 pi 的资源加载器，
//     会扫工作区 skills/、~/.agents/skills、~/.pi/agent/skills、node_modules 包，
//     再加上内置 46 条 → 实测 62 条，界面上"已安装 16 条线上技能"就是这么来的。
//   · 模型真正调的 `activate_skill`（engine/context-loader.mjs）：只扫运行实例的
//     skills/ → 46 条。
// 后果不是"少列几条"，是**看不见**：面板里装着的技能，模型按名字加载会回"技能不存在"，
// 于是它把"路径没接上"误判成"沙箱权限不够"，转头去要求用户放开 danger-full-access
// （2026-10-24 真实发生）。
//
// 这里放一个进程内缓存：面板那边算完就写进来，模型这边直接读。
// 只存结果、不做扫描，避免和任何模块形成循环依赖。
// 不设过期时间——写入方每次 /api/skills 都会刷新；启动时预热一次，够用且可解释。
let cache = null;

/** @param {{name:string, desc?:string, path?:string, source?:string}[]} list */
export function setSkillCache(list) {
  cache = { at: Date.now(), list: Array.isArray(list) ? list : [] };
  return cache;
}

export function getSkillCache() { return cache; }

export function skillCacheAge() { return cache ? Date.now() - cache.at : Infinity; }

/** 测试用：清掉缓存，回到"没有共享清单"的初始态。 */
export function resetSkillCache() { cache = null; }
