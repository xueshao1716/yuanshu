// engine/story-recipes.mjs —— 连续创作的「生成配方」
//
// 这一块照搬的是 ComfyUI 最值钱的一条：**工作流本身是资产**。
// 在 ComfyUI 里你把一张调好的节点图存下来，之后（换个项目、换台机器、发给同事）
// 只改提示词就能复现同一套处理方式——`File → Export (API)` 出来的那份 JSON 就是这件资产。
//
// 元枢此前每次生成都要重选模型、重填负向、重设变体数，而且**跨项目完全无法复用**：
// 同一部片子的 10 个段落，你得把同一套设置点 10 遍。
// 配方把这个"调好的设置"变成一份可存、可套用、可导出、可导入的具名数据。
//
// 刻意保持的东西：
// - 只存**能影响生成结果的参数**（类型/模型/尺寸或时长/负向/seed/变体数），不存提示词——
//   提示词属于故事，配方属于工艺；混在一起就变成"换配方顺手把台词也换了"。
// - 导出的文件是**自足**的（带 kind/version/exportedAt），别人拿到这一个文件就能导入。
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const RECIPE_KINDS = ['novel', 'image', 'video'];
export const RECIPE_FORMAT = 'yuanshu-story-recipes';
export const RECIPE_FORMAT_VERSION = 1;
export const RECIPE_MAX = 100;
// 参考图策略：用几张、谁优先。默认值按"用户显式做了什么"来定，而不是拍脑袋：
//  - 画面（图生图）只有一张入口：用户显式挂的素材**必然**是他的意图，所以默认素材优先；
//    反过来会让"挂了素材却什么都没发生"——最坏的一种静默失败。
//  - 视频（reference 模式）能吃多张：默认先定妆照（保人物），素材跟在后面给场景依据。
export const REF_IMAGES_MAX = 4;
export const defaultRefStrategy = (kind) => ({
  images: kind === 'image' ? 1 : kind === 'video' ? 4 : 0,
  prefer: kind === 'image' ? 'material' : 'portrait',
});
export function normalizeRefStrategy(input, kind) {
  const fallback = defaultRefStrategy(kind);
  const src = input && typeof input === 'object' ? input : {};
  const raw = Number(src.images);
  return {
    images: Number.isFinite(raw) ? Math.max(0, Math.min(REF_IMAGES_MAX, Math.round(raw))) : fallback.images,
    prefer: src.prefer === 'material' || src.prefer === 'portrait' ? src.prefer : fallback.prefer,
  };
}
const FILE = 'story-recipes.json';

const makeId = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

function filePath(root) { return path.join(root, FILE); }

export function normalizeRecipe(input = {}, clock = {}) {
  const now = (clock.now || nowIso)();
  const kind = RECIPE_KINDS.includes(input.kind) ? input.kind : 'image';
  const name = String(input.name || '').trim().slice(0, 60);
  if (!name) throw Object.assign(new Error('配方要有个名字'), { statusCode: 400 });
  const params = input.params && typeof input.params === 'object' && !Array.isArray(input.params)
    ? Object.fromEntries(Object.entries(input.params).filter(([, v]) => v != null && String(v).trim() !== '').slice(0, 12).map(([k, v]) => [String(k).slice(0, 40), String(v).slice(0, 60)]))
    : {};
  // seed 的三态要分清：null/undefined/'' = 没锁；0 是**合法的 seed**，不能被当成"没锁"。
  // 第一版写成 `Number.isFinite(Number(input.seed)) && String(input.seed).trim() !== ''`，
  // 于是前端传 `seed: null`（没锁）会走进 `Number(null) === 0` 这条分支，静默变成一个锁死的 0。
  const rawSeed = input.seed;
  const seed = rawSeed == null || String(rawSeed).trim() === '' || !Number.isFinite(Number(rawSeed)) ? null : Number(rawSeed);
  const variants = Math.max(1, Math.min(4, Number(input.variants) || 1));
  return {
    id: String(input.id || `rcp-${makeId()}`),
    name,
    kind,
    model: { provider: String(input?.model?.provider || 'auto'), id: String(input?.model?.id || 'auto') },
    params,
    negative: String(input.negative || '').trim().slice(0, 1000),
    // 参考图策略是配方的一部分：同一个故事，用几张定妆照、素材优先还是人物优先，
    // 直接决定画面像不像同一个人。以前这条策略是硬编码在编排层里的，用户看不到也改不了。
    reference: normalizeRefStrategy(input.reference, kind),
    seed,
    variants,
    note: String(input.note || '').trim().slice(0, 200),
    createdAt: String(input.createdAt || now),
    updatedAt: now,
  };
}

export async function readRecipeFile(root) {
  try {
    const raw = await fsPromises.readFile(filePath(root), 'utf8');
    const parsed = JSON.parse(raw);
    const recipes = Array.isArray(parsed?.recipes) ? parsed.recipes : [];
    return recipes.map(r => { try { return normalizeRecipe({ ...r, updatedAt: r.updatedAt }, { now: () => r.updatedAt || nowIso() }); } catch { return null; } }).filter(Boolean);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    // 文件坏了要说出来，不要装作"没有配方"——那会让用户以为自己的配方凭空消失
    throw Object.assign(new Error(`配方文件读不出来（${path.basename(filePath(root))}）：${String(e.message).slice(0, 120)}`), { statusCode: 500 });
  }
}

async function writeRecipes(root, recipes) {
  const tmp = `${filePath(root)}.${process.pid}.tmp`;
  await fsPromises.writeFile(tmp, JSON.stringify({ format: RECIPE_FORMAT, version: RECIPE_FORMAT_VERSION, recipes: recipes.slice(0, RECIPE_MAX) }, null, 2), 'utf8');
  await fsPromises.rename(tmp, filePath(root));
  return recipes.slice(0, RECIPE_MAX);
}

export async function listRecipes(root, { kind } = {}) {
  const all = await readRecipeFile(root);
  const filtered = kind ? all.filter(r => r.kind === kind) : all;
  return filtered.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

// 同名即覆盖：给配方起同一个名字两次，用户的意图是"更新它"，不是"再来一份"。
export async function saveRecipe(root, input, clock = {}) {
  const next = normalizeRecipe(input, clock);
  const all = await readRecipeFile(root);
  const byId = all.findIndex(r => r.id === next.id);
  const byName = all.findIndex(r => r.name === next.name);
  const at = byId >= 0 ? byId : byName;
  if (at >= 0) {
    next.id = all[at].id;
    next.createdAt = all[at].createdAt;
    all[at] = next;
  } else {
    all.unshift(next);
  }
  await writeRecipes(root, all);
  return { recipe: next, recipes: all.slice(0, RECIPE_MAX) };
}

export async function deleteRecipe(root, id) {
  const all = await readRecipeFile(root);
  const left = all.filter(r => r.id !== id);
  if (left.length === all.length) return { ok: false, error: '没有这个配方', recipes: all };
  await writeRecipes(root, left);
  return { ok: true, removed: all.length - left.length, recipes: left };
}

// 导出：自足的一份文件，别人拿到就能导入（对应 ComfyUI 的 workflow json 分享）。
export function exportRecipes(recipes, clock = {}) {
  return {
    format: RECIPE_FORMAT,
    version: RECIPE_FORMAT_VERSION,
    exportedAt: (clock.now || nowIso)(),
    recipes: (Array.isArray(recipes) ? recipes : []).map(r => ({ ...r, id: r.id, updatedAt: r.updatedAt })),
  };
}

// 导入：接受导出文件 / 裸数组 / 单个配方三种形状（别人手写的 JSON 常常就是后两种）。
// 同名覆盖，并如实回报每一条的去向——不静默丢弃。
export function parseRecipeImport(payload) {
  const src = Array.isArray(payload) ? payload : Array.isArray(payload?.recipes) ? payload.recipes : payload && typeof payload === 'object' ? [payload] : [];
  const out = [], skipped = [];
  for (const item of src.slice(0, RECIPE_MAX)) {
    try { out.push(normalizeRecipe(item)); }
    catch (e) { skipped.push({ name: String(item?.name || '(无名)').slice(0, 40), reason: String(e.message).slice(0, 80) }); }
  }
  if (!out.length && !skipped.length) throw Object.assign(new Error('这份文件里没有可导入的配方'), { statusCode: 400 });
  return { recipes: out, skipped };
}

export async function importRecipes(root, payload, clock = {}) {
  const { recipes: incoming, skipped } = parseRecipeImport(payload);
  const all = await readRecipeFile(root);
  let added = 0, updated = 0;
  for (const item of incoming) {
    const at = all.findIndex(r => r.name === item.name);
    if (at >= 0) {
      item.id = all[at].id;
      item.createdAt = all[at].createdAt;
      all[at] = item;
      updated += 1;
    } else {
      all.unshift(item);
      added += 1;
    }
  }
  await writeRecipes(root, all);
  return { added, updated, skipped, recipes: all.slice(0, RECIPE_MAX) };
}
