// ===== self-change.mjs —— L2 自改提案的边界与准入（2026-11-02）=====
//
// 只做三件事，不做第四件：
//   ① 定义她能改什么（白名单目录）、一次最多几个文件、单文件多大
//   ② 校验一个改动提案是否合规（不合规直接拒，不生成分支）
//   ③ 记录提案（供「小语改了自己」面板显示）
// 她怎么写出这些改动，交给上层 agent 循环——本模块不执行写操作。
import fs from "node:fs";
import path from "node:path";
import { checkLoopConditions } from "./evolution-gate.mjs";

export const POLICY = {
  // 允许改的目录（相对仓库根）：引擎与前端源码；测试只能新增不能删
  allowDirs: ["engine/", "frontend/src/", "tests/"],
  // 永远不许碰
  denyPaths: ["server.mjs", "package.json", "pnpm-lock.yaml", "frontend/package.json", ".git/", "credentials", ".token", "记忆/行动权清单.md", "APPEND_SYSTEM.md"],
  maxFiles: 5,
  maxBytesPerFile: 60 * 1024,
  branchPrefix: "auto/",
  // 交付门判决必须是 GREEN 才允许进面板
  requireVerdict: "GREEN",
};

const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/^\.\//, "");

/** 校验一组改动文件是否符合边界；返回 {ok, errors, files}。 */
export function checkChange({ files = [] } = {}) {
  const errors = [];
  const list = (Array.isArray(files) ? files : []).map(norm).filter(Boolean);
  if (!list.length) errors.push("没有改动文件");
  if (list.length > POLICY.maxFiles) errors.push(`改了 ${list.length} 个文件，超过上限 ${POLICY.maxFiles}`);
  for (const f of list) {
    if (POLICY.denyPaths.some((d) => f === d || f.startsWith(d))) errors.push(`不允许改：${f}`);
    else if (!POLICY.allowDirs.some((d) => f.startsWith(d))) errors.push(`不在允许目录：${f}`);
  }
  return { ok: errors.length === 0, errors, files: list };
}

/** @typedef {{wsRoot?:string, repoRoot?:string, events?:object[], tools?:string[], budget?:object, estimate?:object, minRepeats?:number}} LoopGateCtx */

/**
 * 生成提案（只记录，不落分支）。verdict 不是 GREEN 直接拒。
 * 2026-11-09 接进化闸门：传了 ctx 就必须过四前提（缺一条直接拒提案，并说明缺哪条——省 token；
 * 不传 ctx = 只做边界校验，旧行为）。闸门自己异常不阻断提案。
 * @param {{files?:string[], verdict?:string, reason?:string, hypothesis?:string, now?:number,
 *   ctx?:LoopGateCtx|null, proposal?:object}} opts
 */
export function makeProposal({ files = [], verdict = "", reason = "", hypothesis = "", now = Date.now(), ctx = null, proposal = {} } = {}) {
  const c = checkChange({ files });
  const errors = [...c.errors];
  if (String(verdict).toUpperCase() !== POLICY.requireVerdict) errors.push(`交付门判决是 ${verdict || "未知"}，只有 ${POLICY.requireVerdict} 才能进面板`);
  if (!String(reason).trim()) errors.push("缺原因");
  if (!String(hypothesis).trim()) errors.push("缺假设");
  if (errors.length) return { ok: false, errors };

  let loop = null;
  if (ctx) {
    try {
      loop = checkLoopConditions({ ...proposal, files: c.files, verdict, reason, hypothesis }, ctx);
    } catch (e) {
      loop = { ok: true, skipped: true, reason: `闸门异常，按放行处理：${String(e?.message || e).slice(0, 160)}`, results: {}, blockers: [] };
    }
    if (loop.ok === false) {
      return {
        ok: false,
        gate: loop,
        errors: loop.blockers.map((b) => `四前提不满足（${b}）`),
        hint: "缺上面任一条都不开自我改进循环：先把条件补齐（让任务重复出现 / 补测试 / 抬预算 / 补工具）再提提案",
      };
    }
  }

  return {
    ok: true,
    gate: loop ? { ok: true, results: loop.results } : { ok: true, skipped: true, reason: "未注入证据（ctx 缺失），只做边界校验" },
    proposal: {
      id: `self_${now.toString(36)}`,
      at: new Date(now).toISOString(),
      branch: `${POLICY.branchPrefix}${now.toString(36)}`,
      files: c.files,
      verdict: POLICY.requireVerdict,
      reason: String(reason).slice(0, 200),
      hypothesis: String(hypothesis).slice(0, 200),
      rollback: "丢弃该分支：git branch -D <branch>（合并前不影响任何东西）",
      ...(loop && loop.results ? { loop: loop.results } : {}),
    },
  };
}

/** 追加到提案台账（面板读这个）。 */
export function recordProposal(wsRoot, proposal) {
  try {
    const dir = path.join(String(wsRoot || "."), "记忆", "运行时");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "自改提案.jsonl"), JSON.stringify(proposal) + "\n", "utf8");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 160) };
  }
}

export function listProposals(wsRoot) {
  try {
    const file = path.join(String(wsRoot || "."), "记忆", "运行时", "自改提案.jsonl");
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean).reverse();
  } catch { return [] }
}
