#!/usr/bin/env node
// ===== scripts/memory-embed-backfill.mjs —— 记忆向量回填（2026-11-15）=====
//
// 把 embedding.mjs 真正接进记忆库：给 memories 的每一行算一条向量写进 memory_vectors 表，
// 召回（engine/memory/recall.mjs）才能走混合分。**幂等**：只补当前模型缺向量的行，重复跑不重复调 API。
//
// 用法（默认 dry-run，不写库也不发请求）：
//   node scripts/memory-embed-backfill.mjs                         # 只统计：总行数/已有/缺/模型/预计调用与耗时
//   node scripts/memory-embed-backfill.mjs --apply                 # 增量回填（每批 ≤20 条）
//   node scripts/memory-embed-backfill.mjs --apply --limit 20      # 试跑 20 条
//   node scripts/memory-embed-backfill.mjs --rebuild --apply       # 强制全量重算（模型换了用这个）
//   node scripts/memory-embed-backfill.mjs --root D:\pi-workspace  # 指定工作区（缺省 YUANSHU_WORKSPACE/自动探测）
//   可加 --json 输出机器可读报告
//
// --rebuild 的"先标记后切换"做法（独立表方案的红利）：
//   ① 全部先写到影子模型名 `<model>~staging`（旧模型向量一行不动，召回继续用旧的）
//   ② 全部成功且没有 --limit 截断时，一个事务里删旧模型行 + staging 改名成正式模型名
//   ③ 中途失败/试跑 → 删掉 staging，旧模型向量原样保留（绝不半新半旧导致召回变差）
//
// 失败不中断：单条失败只记账，继续跑完剩余条目；失败的行下次再跑会被重新拾起（仍缺向量）。
// 退出码：0 全部成功；2 有失败（已写入的保留）；1 参数/配置错误。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initEmbedding, embed as realEmbed, configInfo } from "../engine/embedding.mjs";
import {
  initMemoryDb, resetMemoryDb, memoryDir, memoryVectorStats, listAllMemoryRows, listMemoryIdsWithVector,
  setMemoryVector, deleteMemoryVectorsByModel, switchMemoryVectors, VECTOR_STAGING_SUFFIX,
} from "../engine/memory/db.mjs";
import { defaultWorkspace } from "../engine/workspace-default.mjs";

export const MAX_BATCH = 20;          // 一批最多 20 条（回填是后台动作，别把 embedding 打满）
const EST_MS_PER_CALL = 600;          // dry-run 耗时估算假设（GLM embedding-3 实测 0.3~0.8s/条）
const CHARS_PER_TOKEN = 1.5;          // 中文粗估：1 token ≈ 1.5 字符

/** 纯函数：argv → 模式。测试可直接调，不用起子进程。 */
export function parseBackfillArgs(argv = []) {
  const has = (f) => argv.includes(f);
  const val = (f) => {
    const i = argv.indexOf(f);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    return v && !String(v).startsWith("--") ? v : undefined;
  };
  const rebuild = has("--rebuild");
  const apply = has("--apply");
  const mode = rebuild ? (apply ? "rebuild" : "rebuild-preview") : (apply ? "apply" : "dry-run");
  const limitRaw = val("--limit");
  const batchRaw = val("--batch-size") ?? val("--batch");
  let limit = null;
  if (limitRaw !== undefined) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit <= 0) return { mode: "error", error: "--limit 必须是正整数" };
  }
  let batchSize = MAX_BATCH;
  if (batchRaw !== undefined) {
    const n = Number(batchRaw);
    if (!Number.isInteger(n) || n <= 0) return { mode: "error", error: "--batch-size 必须是正整数" };
    batchSize = Math.min(MAX_BATCH, n);
  }
  return { mode, limit, batchSize, root: val("--root") || "", json: has("--json"), help: has("--help") || has("-h") };
}

const fmtMs = (ms) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

/**
 * 回填主体（不负责初始化 db/embedding：CLI 与测试各自先 initMemoryDb）。
 * @param {object} opts
 * @param {"dry-run"|"apply"|"rebuild"|"rebuild-preview"} opts.mode
 * @param {number|null} opts.limit 最多处理多少条
 * @param {number} opts.batchSize 每批条数（≤20）
 * @param {Function} opts.embed 覆盖 embedding 实现（测试注入；缺省用真实 embedding.mjs）
 * @param {Function} opts.configInfoFn 覆盖配置读取（测试注入）
 * @param {Function} opts.log 进度输出（测试传空函数）
 */
export async function runBackfill({
  mode = "dry-run", limit = null, batchSize = MAX_BATCH,
  embed = null, configInfoFn = configInfo, log = () => {}, now = () => Date.now(),
} = {}) {
  const writes = mode === "apply" || mode === "rebuild";
  const rebuild = mode === "rebuild" || mode === "rebuild-preview";
  let cfg = {};
  try { cfg = configInfoFn() || {}; } catch { cfg = {}; }
  const model = cfg.configured ? String(cfg.model || "") : "";
  const configured = !!(cfg.configured && model);

  const rows = listAllMemoryRows({ status: "" });
  const total = rows.length;
  const before = memoryVectorStats({ model: model || "" });
  const idsWith = model ? listMemoryIdsWithVector(model) : new Set();
  const missingRows = rows.filter(r => !idsWith.has(r.memory_id));
  const candidatesAll = rebuild ? rows : missingRows;
  const capped = Number.isInteger(limit) && limit > 0 ? Math.min(limit, candidatesAll.length) : candidatesAll.length;
  const candidates = candidatesAll.slice(0, capped);
  const chars = candidates.reduce((n, r) => n + String(r.summary || "").length, 0);
  const tokensEstimated = Math.ceil(chars / CHARS_PER_TOKEN);

  const base = {
    mode, dryRun: !writes, root: (() => { try { return path.dirname(memoryDir()); } catch { return ""; } })(),
    configured, model: model || "(未配置)", batchSize,
    total, existing: before.withVec, missing: before.missing, otherModels: before.models.filter(m => m.model !== model),
    candidates: candidates.length, tokensEstimated,
    estMs: candidates.length * EST_MS_PER_CALL,
  };

  if (!writes) {
    return {
      ok: true, ...base,
      wouldCall: candidates.length,
      wouldSwitch: rebuild && configured && candidates.length === total && total > 0 && !(Number.isInteger(limit) && limit > 0 && limit < total),
      note: !configured ? "embedding 未配置：只能统计，--apply 会被拒绝" :
        rebuild ? "rebuild 预览：实际会先写影子模型再整体切换" : "dry-run：不写库、不发请求",
    };
  }
  if (!configured) {
    return { ok: false, ...base, error: "embedding 未配置（缺 memory/embedding.json 且未找到 zai/zai-coding-cn 凭据），不调 API" };
  }

  const embedFn = embed || realEmbed;
  const stagingModel = rebuild ? `${model}${VECTOR_STAGING_SUFFIX}` : "";
  if (rebuild) deleteMemoryVectorsByModel(stagingModel); // 清掉上次试跑残留

  const batches = [];
  for (let i = 0; i < candidates.length; i += batchSize) batches.push(candidates.slice(i, i + batchSize));
  log(`开始回填：${candidates.length} 条，${batches.length} 批（每批 ≤${batchSize}），模型 ${model} → ${rebuild ? stagingModel : model}`);

  const failures = [];
  let embedded = 0, dim = 0;
  const t0 = Date.now();
  for (let b = 0; b < batches.length; b += 1) {
    for (const row of batches[b]) {
      try {
        const vec = await embedFn(String(row.summary || ""));
        if (!Array.isArray(vec) || !vec.length) throw new Error("embedding 返回空向量");
        const saved = setMemoryVector(row.memory_id, { model: rebuild ? stagingModel : model, vec, at: now() });
        dim = saved.dim;
        embedded += 1;
      } catch (e) {
        // 失败不中断：记下来继续跑，失败行仍缺向量，下次重跑会再拾起
        failures.push({ id: row.memory_id, error: String(e?.message || e).slice(0, 160) });
      }
    }
    if (batches.length > 1) log(`  批次 ${b + 1}/${batches.length} 完成：成功 ${embedded}，失败 ${failures.length}`);
  }
  const elapsedMs = Date.now() - t0;

  let switched = null;
  if (rebuild) {
    if (failures.length === 0 && candidates.length === total && total > 0) {
      switched = switchMemoryVectors({ from: stagingModel, to: model, dropOthers: true });
    } else {
      const reason = failures.length
        ? `失败 ${failures.length} 条，不切换（旧模型向量原样保留）`
        : `只算了 ${candidates.length}/${total} 条（--limit 试跑），不切换`;
      const cleaned = deleteMemoryVectorsByModel(stagingModel);
      switched = { skipped: true, reason, cleaned: cleaned.deleted };
    }
  }
  const after = memoryVectorStats({ model });
  return {
    ok: failures.length === 0,
    ...base, dryRun: false,
    batchCount: batches.length, embedded, failed: failures.length, dim: dim || null,
    elapsedMs, switched, after,
    failures: failures.slice(0, 10),
    failureCount: failures.length,
  };
}

function printReport(r) {
  const line = "─".repeat(60);
  console.log(line);
  console.log("记忆向量回填报告");
  console.log(line);
  if (r.root) console.log(`工作区        ${r.root}`);
  console.log(`模式          ${r.mode}${r.dryRun ? "（dry-run：不写库、不发请求）" : ""}`);
  console.log(`embedding     ${r.configured ? r.model : "未配置"}${r.configured ? "" : "（缺 memory/embedding.json 且无 zai 凭据）"}`);
  console.log(`总行数        ${r.total}`);
  console.log(`已有向量      ${r.existing}（跳过：已有当前模型向量）`);
  console.log(`缺向量        ${r.missing}`);
  const others = (r.otherModels || []).map(m => `${m.model}(${m.count}条/${m.dim}维)`);
  if (others.length) console.log(`其他模型残留  ${others.join("、")}（rebuild 成功后会清掉）`);
  if (r.dryRun) {
    console.log(`预计调用      ${r.wouldCall} 次 ≈ ${r.tokensEstimated} tokens ≈ ${fmtMs(r.estMs)}（按 ${EST_MS_PER_CALL}ms/次估）`);
    if (r.mode === "rebuild-preview") console.log(`rebuild 预览  ${r.wouldSwitch ? "会先写 staging，全部成功后再整体切换" : "调用条数不足全量：只会写 staging 不切换"}`);
    console.log(`说明          ${r.note}`);
    return;
  }
  if (r.error) { console.log(`错误          ${r.error}`); return; }
  console.log(`实际调用      ${r.embedded + r.failed} 次（新增 ${r.embedded} / 失败 ${r.failed}）`);
  console.log(`向量维度      ${r.dim || "-"}`);
  console.log(`批次数        ${r.batchCount}（每批 ≤${r.batchSize}）`);
  console.log(`耗时          ${fmtMs(r.elapsedMs)}`);
  console.log(`token 估算    ≈ ${r.tokensEstimated} tokens`);
  if (r.switched) {
    if (r.switched.skipped) console.log(`模型切换      跳过：${r.switched.reason}（清理 staging ${r.switched.cleaned} 条）`);
    else console.log(`模型切换      完成：移动 ${r.switched.moved} 条，覆盖旧 ${r.switched.replaced} 条，清理其它模型 ${r.switched.dropped} 条`);
  }
  if (r.after) console.log(`回填后覆盖    ${r.after.withVec}/${r.after.total}（缺 ${r.after.missing}）`);
  if (r.failureCount) {
    console.log(`失败样例（前 ${r.failures.length} 条，共 ${r.failureCount} 条）：`);
    for (const f of r.failures) console.log(`  - ${f.id}：${f.error}`);
    console.log("失败行未写入，重跑同一命令即可续上（只补缺向量的行）。");
  }
  console.log(line);
}

async function main() {
  const args = parseBackfillArgs(process.argv.slice(2));
  if (args.help || args.mode === "error") {
    if (args.error) console.error(`❌ ${args.error}`);
    console.log("用法: node scripts/memory-embed-backfill.mjs [--apply] [--rebuild] [--limit N] [--batch-size N] [--root 工作区] [--json]");
    return args.mode === "error" ? 1 : 0;
  }
  const root = args.root || process.env.YUANSHU_WORKSPACE || process.env.PI_WORKSPACE || defaultWorkspace();
  initMemoryDb(root);
  initEmbedding(root);
  try {
    const r = await runBackfill({ mode: args.mode, limit: args.limit, batchSize: args.batchSize, log: (m) => console.log(m) });
    if (args.json) console.log(JSON.stringify(r, null, 2));
    else printReport(r);
    if (r.error) return 1;
    return r.ok ? 0 : 2;
  } finally {
    resetMemoryDb();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    console.error(`❌ 回填失败：${e?.stack || e}`);
    process.exitCode = 1;
  });
}
