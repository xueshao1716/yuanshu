// ===== patch-runner.mjs —— 无人值守：生成 → 白名单校验 → 门禁 → 建分支提交 / 失败回滚（2026-10-26）=====
//
// 用户决定：无人值守。
// 这里的红线（写死在代码里，不靠自觉）：
//   · **永不合并到 main**：成功只建 `auto/capability-<id>` 分支并提交，等人审；
//   · **永不越过 PLAN 白名单**：patch-generator 已校验，这里再校验一次（两道）；
//   · **失败必须回滚且写明原因**：写回提案 note + attempts，不静默重试；
//   · **有闸**：YUANSHU_AUTOPATCH=1 才跑；每小时最多 1 个；同一提案最多 3 次。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { beginPatch, verifyPatch, changedFiles, rollback } from "./patch-guard.mjs";
import { validatePatch } from "./patch-generator.mjs";
import { readProposals, writeProposals, markProposal } from "./capability-proposal.mjs";

export const MAX_ATTEMPTS = 3;
export const MIN_INTERVAL_MS = 55 * 60 * 1000;

function git(repoRoot, args) {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", timeout: 120000, windowsHide: true });
  return { ok: r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}`.trim(), code: r.status };
}

/** 挑一个够格的提案：accepted + 有 plan + 没超次数 + 没在跑。 */
export function pickEligible(wsRoot, { now = Date.now(), minInterval = MIN_INTERVAL_MS } = {}) {
  const data = readProposals(wsRoot);
  const items = data.items || [];
  const last = items.reduce((max, p) => Math.max(max, Number(p.lastAttemptAt) || 0), 0);
  if (last && now - last < minInterval) return { skip: "rate_limited", waitMs: minInterval - (now - last) };
  const candidate = items.find((p) => {
    if (p.state !== "accepted") return false;
    if (!p.planPath || !fs.existsSync(p.planPath)) return false;
    if ((Number(p.attempts) || 0) >= MAX_ATTEMPTS) return false;
    return true;
  });
  return candidate ? { proposal: candidate } : { skip: "nothing_eligible" };
}

/** 把生成的文件写进仓库（只写白名单内的）。 */
function writeFiles(repoRoot, files) {
  const written = [];
  for (const f of files) {
    const abs = path.join(repoRoot, f.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content, "utf8");
    written.push(f.path);
  }
  return written;
}

/**
 * 跑一个提案。dryRun=true 只生成+校验，不落盘不提交。
 * @returns {{ok:boolean, stage:string, error?:string, branch?:string, commit?:string, files?:string[]}}
 */
export async function runProposal({ wsRoot, repoRoot, proposal, generate, dryRun = false, log = () => {} }) {
  const t0 = Date.now();
  const planPath = proposal.planPath;
  if (!planPath || !fs.existsSync(planPath)) return { ok: false, stage: "plan", error: "没有 PLAN.md" };
  const plan = { ...proposal, files: proposal.files || [] };
  const md = fs.readFileSync(planPath, "utf8");
  // PLAN.md 里列的文件才是权威（人可能手改过）
  const listed = [...md.matchAll(/^- `([^`]+)`$/gm)].map((m) => m[1]).filter((p) => !/[（(]/.test(p));
  if (listed.length) plan.files = [...new Set([...plan.files, ...listed])];

  log(`生成补丁：${proposal.title}`);
  const patch = await generate(plan);
  const checked = validatePatch(repoRoot, plan, patch);
  if (!checked.ok) {
    markProposal(wsRoot, proposal.id, { state: "accepted", note: `自动补丁未通过校验：${checked.error}`, attempts: (Number(proposal.attempts) || 0) + 1, lastAttemptAt: t0 });
    return { ok: false, stage: "validate", error: checked.error };
  }
  log(`校验通过：${checked.files.map((f) => f.path).join(", ")}`);
  if (dryRun) return { ok: true, stage: "dry_run", files: checked.files.map((f) => f.path) };

  const begun = beginPatch({ repoRoot, plan, files: checked.files.map((f) => f.path), wsRoot });
  if (!begun.ok) {
    markProposal(wsRoot, proposal.id, { state: "accepted", note: `开改被拒：${begun.error}`, attempts: (Number(proposal.attempts) || 0) + 1, lastAttemptAt: t0 });
    return { ok: false, stage: "scope", error: begun.error };
  }
  const session = begun.session;
  writeFiles(repoRoot, checked.files);

  const gate = verifyPatch({ session, testFile: proposal.testPath && fs.existsSync(proposal.testPath) ? proposal.testPath : null, full: true });
  if (!gate.ok) {
    markProposal(wsRoot, proposal.id, { state: "accepted", note: `门禁未过（已回滚）：${gate.error}`, attempts: (Number(proposal.attempts) || 0) + 1, lastAttemptAt: t0 });
    return { ok: false, stage: "gate", error: gate.error, steps: gate.steps };
  }

  // 成功：建分支提交（**不推、不并 main**）
  const branch = `auto/capability-${String(proposal.id).slice(0, 8)}`;
  const cur = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const checkout = git(repoRoot, ["checkout", "-B", branch]);
  if (!checkout.ok) {
    rollback(session);
    markProposal(wsRoot, proposal.id, { state: "accepted", note: `建分支失败：${checkout.out.slice(0, 120)}`, attempts: (Number(proposal.attempts) || 0) + 1, lastAttemptAt: t0 });
    return { ok: false, stage: "branch", error: checkout.out.slice(0, 200) };
  }
  git(repoRoot, ["add", ...changedFiles(session).map((c) => c.rel)]);
  const commit = git(repoRoot, ["-c", "user.name=元枢自动补丁", "-c", "user.email=autopatch@local", "commit", "-m",
    `autopatch(${proposal.area || "general"}): ${String(proposal.title).slice(0, 60)}\n\n由能力提案自动生成并通过门禁；请人工审阅后再合并。\n提案: ${proposal.id}`]);
  if (!commit.ok) {
    rollback(session);
    git(repoRoot, ["checkout", cur.out || "main"]);
    markProposal(wsRoot, proposal.id, { state: "accepted", note: `提交失败：${commit.out.slice(0, 120)}`, attempts: (Number(proposal.attempts) || 0) + 1, lastAttemptAt: t0 });
    return { ok: false, stage: "commit", error: commit.out.slice(0, 200) };
  }
  const sha = git(repoRoot, ["rev-parse", "--short", "HEAD"]);
  // 回到原分支，工作树干净，改动留在新分支上
  git(repoRoot, ["checkout", cur.out || "main"]);

  const data = readProposals(wsRoot);
  const p = (data.items || []).find((x) => x.id === proposal.id);
  if (p) {
    Object.assign(p, {
      state: "patch_ready", patchBranch: branch, patchCommit: sha.out.slice(0, 12),
      patchFiles: checked.files.map((f) => f.path), attempts: (Number(p.attempts) || 0) + 1, lastAttemptAt: t0,
      note: `自动补丁已就绪：分支 ${branch} @ ${sha.out.slice(0, 12)}，等人审`,
    });
    writeProposals(wsRoot, data);
  }
  return { ok: true, stage: "committed", branch, commit: sha.out.slice(0, 12), files: checked.files.map((f) => f.path) };
}

/** 队列跑一轮（默认 1 个）。 */
export async function runQueue({ wsRoot, repoRoot, generate, limit = 1, dryRun = false, log = () => {}, now = Date.now() }) {
  const results = [];
  for (let i = 0; i < limit; i += 1) {
    const pick = pickEligible(wsRoot, { now });
    if (!pick.proposal) return { ok: true, results, skip: pick.skip };
    results.push({ id: pick.proposal.id, ...(await runProposal({ wsRoot, repoRoot, proposal: pick.proposal, generate, dryRun, log })) });
    if (!results[results.length - 1].ok && !dryRun) break; // 失败就不连着撞
  }
  return { ok: true, results };
}
