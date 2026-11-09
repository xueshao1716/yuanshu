// GRN 最后一层：5 维成长 + 换代（人批准，不自动晋升）+ 回滚（2026-11-09）
// 锁住：单轮增量上限、累积封顶、满级只出提案不晋升、promote 必须 human-confirm:、
//       批准后归档/重置、拒绝留痕与冷却、rollback 弹栈回上一代、信号缺失 skipped 不造假、
//       statusText 三态、落盘读回、坏文件降级。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DIMS, DIM_LABELS, MAX_STEP, RESET_DROP, RESET_FLOOR, PROPOSAL_COOLDOWN_TURNS,
  CAPS, GOVERNANCE_WINDOW, GOVERNANCE_PENALTY, MIN_GOVERNANCE_TURNS, JUDGMENT_FULL_RATIO,
  init, current, filePath, advance, promote, reject, rollback,
  resetDims, measure, parseCorrections, status, statusText, promptLine,
} from "../../engine/genome-growth.mjs";
import { init as initGenome, current as genomeCurrent } from "../../engine/genome.mjs";
import { createGrowthApproval } from "../../engine/growth-approval.mjs";

const ALL_ONE = Object.fromEntries(DIMS.map((d) => [d, 1]));
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "growth-"));
const dirOf = (root) => path.join(root, "记忆", "运行时");
const stateFile = (root) => path.join(dirOf(root), "成长.json");

const seedGrowth = (root, patch = {}) => {
  fs.mkdirSync(dirOf(root), { recursive: true });
  fs.writeFileSync(stateFile(root), JSON.stringify(patch), "utf8");
};
const seedJson = (root, rel, obj) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj), "utf8");
};
const seedText = (root, rel, text) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, "utf8");
};

/** 每个用例一个临时工作区；基因层同步初始化，基因快照才可复现。 */
function fresh(patch = null) {
  const root = tmpRoot();
  fs.mkdirSync(dirOf(root), { recursive: true });
  if (patch) seedGrowth(root, patch);
  init(root);
  initGenome(root);
  return root;
}

describe("状态与一行摘要", () => {
  test("新工作区：5 维为 0 / 第 0 代 / 无待批提案 / 一行正常摘要", () => {
    const root = fresh();
    const st = current();
    assert.deepEqual(st.dims, { companion: 0, understanding: 0, judgment: 0, responsibility: 0, governance: 0 });
    assert.equal(st.generation, 0);
    assert.equal(st.pending, null);
    assert.deepEqual(st.generations, []);
    assert.equal(filePath(), stateFile(root));

    const line = statusText();
    assert.equal(line.includes("\n"), false);
    assert.equal(line, "成长：陪伴 0.00 / 理解 0.00 / 判断 0.00 / 承担 0.00 / 治理 0.00 · 第 0 代");
    assert.equal(promptLine(), line, "prompt 用的就是这一行，不再多一段");
  });

  test("status()：5 维 + 世代 + 是否待批 + 标签 + 一行（无换行）", () => {
    fresh({ dims: ALL_ONE });
    advance({});
    const s = status();
    assert.equal(Object.keys(s.dims).length, 5);
    assert.equal(s.labels.companion, "陪伴");
    assert.equal(s.labels.governance, "治理");
    assert.equal(s.generation, 0);
    assert.equal(s.hasPending, true);
    assert.ok(s.pending && s.pending.id);
    assert.deepEqual(s.generations, []);
    assert.equal(typeof s.prompt, "string");
    assert.equal(s.prompt.includes("\n"), false);
    assert.equal(s.file, path.join("记忆", "运行时", "成长.json"));
  });
});

describe("累积：单轮上限 + 封顶", () => {
  test("单轮每维 ≤ 0.02：传 5 也只涨 0.02；负数不生效（成长不倒退）", () => {
    fresh();
    advance({ companion: 5 });
    assert.equal(current().dims.companion, MAX_STEP);
    advance({ companion: -1 });
    assert.equal(current().dims.companion, MAX_STEP);
    assert.equal(MAX_STEP, 0.02);
  });

  test("累积封顶 1.0：60 轮 × 0.02 停在第 50 轮满级，五维不越界", () => {
    fresh();
    let firstPendingAt = 0;
    for (let i = 1; i <= 60; i++) {
      const out = advance(Object.fromEntries(DIMS.map((d) => [d, MAX_STEP])));
      if (out.pending && !firstPendingAt) firstPendingAt = i;
    }
    const st = current();
    for (const d of DIMS) assert.equal(st.dims[d], 1, `${d} 应封顶在 1`);
    assert.equal(firstPendingAt, 50, "0.02 × 50 = 1.0，恰好第 50 轮才够满级");
    assert.equal(st.generation, 0, "满级也不许自动换代");
  });

  test("五维满级只生成提案：promoted=false、generation 不变、提案带旧值/新值/理由/drift", () => {
    fresh({ dims: ALL_ONE });
    const out = advance({}, { reason: "五维都满了" });
    assert.equal(out.ok, true);
    assert.equal(out.promoted, false);
    assert.equal(out.pending, true);
    assert.equal(out.proposed, true);
    assert.ok(out.proposal);
    assert.equal(out.proposal.toGeneration, 1);
    assert.equal(out.proposal.fromGeneration, 0);
    assert.deepEqual(out.proposal.dims, ALL_ONE);
    assert.deepEqual(out.proposal.nextDims, resetDims(ALL_ONE));
    assert.equal(out.proposal.reason, "五维都满了");
    assert.ok("drift" in out.proposal, "提案要带漂移快照");
    assert.equal(current().generation, 0);

    // 下一轮不会重复生成同一条提案，也不会晋升
    const again = advance({});
    assert.equal(again.proposed, false);
    assert.equal(again.proposal.id, out.proposal.id);
    assert.equal(current().generation, 0);
  });

  test("重置规则（纯函数）：全维 −0.5 保留底子，但不低于 0.2", () => {
    assert.deepEqual(resetDims(ALL_ONE), { companion: 0.5, understanding: 0.5, judgment: 0.5, responsibility: 0.5, governance: 0.5 });
    assert.equal(resetDims({ companion: 0.4 }).companion, RESET_FLOOR);
    assert.equal(resetDims({ companion: 0.1 }).companion, RESET_FLOOR);
    assert.equal(resetDims({}).companion, RESET_FLOOR);
    assert.equal(RESET_DROP, 0.5);
  });
});

describe("promote：必须人批准", () => {
  test("无 approvedBy / 空串 / 非 human-confirm: 前缀 → 全部拒绝，状态不变", () => {
    fresh({ dims: ALL_ONE });
    advance({});
    for (const bad of [undefined, "", "operator", "human-confirm", "humanconfirm:x", "human-confirm "]) {
      const out = promote({ approvedBy: bad, reason: "试一下" });
      assert.equal(out.ok, false, `approvedBy=${JSON.stringify(bad)} 不该通过`);
      assert.equal(out.promoted, false);
      assert.equal(out.code, "human_confirm_required");
    }
    const st = current();
    assert.equal(st.generation, 0);
    assert.ok(st.pending, "被拒后提案还在，等人真的批准");
  });

  test("没有待批提案时 promote 直接拒绝", () => {
    fresh();
    const out = promote({ approvedBy: "human-confirm:s1:c1" });
    assert.equal(out.ok, false);
    assert.equal(out.code, "no_pending_proposal");
  });

  test("批准后：generation+1、旧 dims/基因快照进 generations[]、dims 按规则重置、baseline=新值", () => {
    const root = fresh({ dims: ALL_ONE });
    advance({}, { reason: "满级" });
    const out = promote({ approvedBy: "human-confirm:s1:c1", reason: "换代吧" });
    assert.equal(out.ok, true);
    assert.equal(out.promoted, true);
    assert.equal(out.generation, 1);

    const st = current();
    assert.equal(st.generation, 1);
    assert.equal(st.pending, null);
    assert.equal(st.generations.length, 1);
    const archived = st.generations[0];
    assert.equal(archived.gen, 0);
    for (const d of DIMS) assert.equal(archived.dims[d], 1);
    assert.ok(archived.genes && typeof archived.genes === "object", "基因快照要一起归档");
    assert.ok(Object.keys(archived.genes).length > 0);
    assert.equal(archived.approvedBy, "human-confirm:s1:c1");
    assert.equal(archived.reason, "换代吧");
    assert.ok(archived.proposalId);

    for (const d of DIMS) assert.equal(st.dims[d], 1 - RESET_DROP, `${d} 应按重置规则落到 0.5`);
    assert.deepEqual(st.baseline.dims, st.dims);
    assert.equal(st.baseline.generation, 1);
    assert.equal(st.baseline.approvedBy, "human-confirm:s1:c1");
    assert.equal(st.history.at(-1).action, "promote");
    assert.equal(st.history.at(-1).generation, 1);

    // 基因层的「世代」跟同一份台账走，不是第二个 0
    assert.equal(genomeCurrent().generation, 1);
    assert.equal(out.genome.generation, 1);
  });
});

describe("reject：保持原代 + 留痕 + 冷却", () => {
  test("拒绝后提案进 history（含内容）、generation 不变、冷却期内不再弹提案", () => {
    fresh({ dims: ALL_ONE, evidence: { turns: 10, guardBlocks: 0, guardWindow: [] } });
    advance({});
    const out = reject({ by: "伙伴", reason: "这代还不稳" });
    assert.equal(out.ok, true);
    assert.equal(out.rejected, true);
    assert.equal(current().generation, 0);
    assert.equal(current().pending, null);

    const h = current().history.at(-1);
    assert.equal(h.action, "reject");
    assert.equal(h.by, "伙伴");
    assert.equal(h.reason, "这代还不稳");
    assert.equal(h.proposalId, out.proposal.id);
    assert.ok(h.proposal && h.proposal.dims, "被拒的提案要留痕，不是删掉");
    assert.equal(current().cooldownUntilTurn, 11 + PROPOSAL_COOLDOWN_TURNS);

    // 冷却期内：满级状态还在，但不许下一轮立刻又弹
    for (let i = 0; i < 3; i++) {
      const next = advance({});
      assert.equal(next.pending, false, `冷却第 ${i + 1} 轮不该再弹提案`);
    }
  });
});

describe("rollback：人批准回到上一代", () => {
  test("dims 与归档一致、generations 弹栈、pending 清空；无 human-confirm 拒绝", () => {
    fresh({ dims: ALL_ONE });
    advance({});
    promote({ approvedBy: "human-confirm:s1:c1", reason: "第一次换代" });
    const archived = current().generations[0];
    assert.equal(current().dims.companion, 0.5);

    const denied = rollback({ reason: "手滑了" });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, "human_confirm_required");

    const out = rollback({ approvedBy: "human-confirm:s1:c2", reason: "上一代更稳" });
    assert.equal(out.ok, true);
    assert.equal(out.rolledBack, true);
    const st = current();
    assert.equal(st.generation, archived.gen);
    assert.deepEqual(st.dims, archived.dims, "回滚后的 dims 必须与归档逐维一致");
    assert.equal(st.generations.length, 0);
    assert.equal(st.pending, null);
    assert.equal(st.history.at(-1).action, "rollback");
    assert.equal(genomeCurrent().generation, 0);
  });

  test("没有可回退的上一代 → 拒绝；没有理由 → 拒绝", () => {
    fresh();
    const none = rollback({ approvedBy: "human-confirm:s1:c1", reason: "x" });
    assert.equal(none.ok, false);
    assert.equal(none.code, "no_previous_generation");

    fresh({ dims: ALL_ONE });
    advance({});
    promote({ approvedBy: "human-confirm:s1:c1", reason: "换代" });
    const noReason = rollback({ approvedBy: "human-confirm:s1:c2", reason: "  " });
    assert.equal(noReason.ok, false);
    assert.equal(noReason.code, "reason_required");
    assert.equal(current().generation, 1, "被拒的回滚不改世代");
  });
});

describe("信号来源：只读真实台账，缺就 skipped", () => {
  test("空工作区：5 维全部 skipped，advance(null) 一点假增长都不产生", () => {
    fresh();
    const m = measure();
    assert.equal(Object.keys(m.values).length, 0);
    for (const key of ["陪伴", "理解", "判断", "承担", "治理"]) {
      assert.ok(m.skipped.some((s) => s.includes("（跳过）") && s.includes(key)), `缺 ${key} 的数据来源要标 skipped：${m.skipped.join(" | ")}`);
    }
    assert.ok(m.skipped.some((s) => s.includes("用户澄清次数")), "拿不到「澄清次数」要明确说明");

    const out = advance(null);
    for (const d of DIMS) assert.equal(current().dims[d], 0, `${d} 没有数据就不该涨`);
    assert.equal(out.measured.companion, undefined);
  });

  test("陪伴 = 关系层 interactions / 200（当前值 = 已知量 / 上限）", () => {
    const root = fresh();
    seedJson(root, path.join("记忆", "运行时", "关系.json"), { trust: 0.6, intimacy: 0.5, interactions: 100, notes: [] });
    const m = measure();
    assert.equal(m.values.companion, 0.5);
    assert.equal(m.sources.companion.raw, 100);
    assert.equal(m.sources.companion.cap, CAPS.companion);

    const out = advance(null);
    assert.equal(out.deltas.companion, MAX_STEP);
    assert.equal(current().dims.companion, MAX_STEP);
  });

  test("理解 = 纠正记忆去重条数 / 20；同一句重复纠正不涨理解", () => {
    const root = fresh();
    const text = [
      "### 2026-11-09T10:00:00Z", "- 触发: a", "- 纠正: 不要用随机数凑成长",
      "### 2026-11-09T11:00:00Z", "- 触发: b", "- 纠正: 不要用随机数凑成长",
      "### 2026-11-09T12:00:00Z", "- 触发: c", "- 纠正: 先跑测试再报完成",
    ].join("\n");
    seedText(root, path.join("记忆", "纠正记忆.md"), text);

    const p = parseCorrections(text);
    assert.equal(p.total, 3);
    assert.equal(p.unique, 2, "同一句话纠正十次只算一条（复犯不给成长）");

    const m = measure();
    assert.equal(m.values.understanding, 2 / CAPS.understanding);
    assert.equal(m.sources.understanding.repeats, 1);
  });

  test("判断 = GREEN 比例 × 样本置信（90% GREEN 算满值，20 条满信）；样本 < 5 跳过", () => {
    const root = fresh();
    seedJson(root, path.join("记忆", "运行时", "交付门.json"), {
      items: Array.from({ length: 10 }, (_, i) => ({ verdict: i < 9 ? "GREEN" : "RED" })),
    });
    let m = measure();
    assert.equal(m.values.judgment, 0.5, "90% GREEN 视为满值 × 10/20 的样本置信");
    assert.equal(m.sources.judgment.raw, "9/10");
    assert.equal(m.sources.judgment.fullRatio, JUDGMENT_FULL_RATIO);

    // 20 条、90% GREEN → 满信满比例
    const root20 = fresh();
    seedJson(root20, path.join("记忆", "运行时", "交付门.json"), {
      items: Array.from({ length: 20 }, (_, i) => ({ verdict: i < 18 ? "GREEN" : "RED" })),
    });
    m = measure();
    assert.equal(m.values.judgment, 1);

    const root2 = fresh();
    seedJson(root2, path.join("记忆", "运行时", "交付门.json"), { items: [{ verdict: "GREEN" }] });
    m = measure();
    assert.equal(m.values.judgment, undefined);
    assert.ok(m.skipped.some((s) => s.includes("交付门只有 1 条")));
  });

  test("承担 = 值班日志 wake_done / 30；没有值班日志就跳过", () => {
    const root = fresh();
    const dir = dirOf(root);
    const lines = Array.from({ length: 15 }, () => JSON.stringify({ event: "wake_done" }));
    lines.push(JSON.stringify({ event: "wake_error", error: "x" }));
    fs.writeFileSync(path.join(dir, "值班日志-20261109.jsonl"), lines.join("\n") + "\n", "utf8");

    const m = measure();
    assert.equal(m.values.responsibility, 0.5);
    assert.equal(m.sources.responsibility.raw, 15);
    assert.equal(m.sources.responsibility.failed, 1);
    assert.equal(advance(null).deltas.responsibility, MAX_STEP);

    const root2 = fresh();
    const m2 = measure();
    assert.equal(m2.values.responsibility, undefined);
    assert.ok(m2.skipped.some((s) => s.includes("没有值班日志")));
  });

  test("治理 = 1 − 近 200 轮拦截次数 × 0.2；不足 20 轮且无拦截则跳过", () => {
    const root = fresh({ dims: {}, evidence: { turns: 19, guardBlocks: 0, guardWindow: [] } });
    let m = measure();
    assert.equal(m.values.governance, undefined);
    assert.ok(m.skipped.some((s) => s.includes(`需 ≥${MIN_GOVERNANCE_TURNS} 轮`)));

    const out = advance(null);
    assert.equal(out.measured.governance, 1, "跑够 20 轮且一次没被拦 → 治理满信");
    assert.equal(out.deltas.governance, MAX_STEP);
    assert.equal(current().evidence.turns, 20);

    fresh({ dims: {}, evidence: { turns: 40, guardBlocks: 3, guardWindow: [20, 25, 30] } });
    m = measure();
    assert.equal(m.values.governance, 1 - 3 * GOVERNANCE_PENALTY);
    assert.equal(GOVERNANCE_WINDOW, 200);

    // 超出窗口的旧拦截不再扣分
    fresh({ dims: {}, evidence: { turns: 400, guardBlocks: 3, guardWindow: [20, 25, 30] } });
    m = measure();
    assert.equal(m.values.governance, 1);
  });

  test("本轮红线拦截计入 evidence：guardBlocks>0 时治理被扣分", () => {
    fresh({ dims: {}, evidence: { turns: 30, guardBlocks: 0, guardWindow: [] } });
    const out = advance(null, { guardBlocks: 2 });
    assert.equal(current().evidence.guardBlocks, 2);
    assert.equal(current().evidence.guardWindow.length, 2);
    assert.equal(out.measured.governance, 1 - 2 * GOVERNANCE_PENALTY);
  });
});

describe("statusText：三种状态都在一行里", () => {
  test("正常 / 待批 / 多代", () => {
    fresh({ dims: { companion: 0.62, understanding: 0.55, judgment: 0.48, responsibility: 0.4, governance: 0.31 } });
    assert.equal(statusText(), "成长：陪伴 0.62 / 理解 0.55 / 判断 0.48 / 承担 0.40 / 治理 0.31 · 第 0 代");

    fresh({ dims: ALL_ONE });
    advance({});
    const pendingLine = statusText();
    assert.ok(pendingLine.includes("（有换代提案待批）"), pendingLine);
    assert.ok(pendingLine.includes("第 0 代"), pendingLine);

    fresh({ dims: ALL_ONE });
    advance({});
    promote({ approvedBy: "human-confirm:s1:c1", reason: "换代" });
    const multiLine = statusText();
    assert.ok(multiLine.includes("第 1 代（已归档 1 代）"), multiLine);
    assert.equal(multiLine.includes("\n"), false);
    assert.equal(multiLine.includes("待批"), false);
  });
});

describe("落盘 / 读回 / 坏文件降级", () => {
  test("advance 原子写 记忆/运行时/成长.json，重开后读回一致", () => {
    const root = fresh();
    const t = Date.parse("2026-11-09T12:00:00Z");
    advance({ companion: 0.01, judgment: 0.02 }, { reason: "测试", now: t });
    assert.ok(fs.existsSync(stateFile(root)));
    const saved = JSON.parse(fs.readFileSync(stateFile(root), "utf8"));
    for (const k of ["dims", "generation", "generations", "pending", "evidence", "updatedAt"]) {
      assert.ok(k in saved, `落盘缺字段 ${k}`);
    }
    assert.equal(saved.updatedAt, new Date(t).toISOString());
    assert.equal(saved.dims.companion, 0.01);

    init("");
    init(root);
    assert.deepEqual(current().dims, saved.dims);
    assert.deepEqual(current().evidence, saved.evidence);
  });

  test("坏 JSON → 按默认值起不抛；下一轮写盘修复成合法 JSON", () => {
    const root = tmpRoot();
    fs.mkdirSync(dirOf(root), { recursive: true });
    fs.writeFileSync(stateFile(root), "{ 这不是 json", "utf8");
    init(root);

    const st = current();
    for (const d of DIMS) assert.equal(st.dims[d], 0);
    assert.equal(st.generation, 0);
    assert.equal(st.pending, null);

    advance({ companion: 0.01 });
    const repaired = JSON.parse(fs.readFileSync(stateFile(root), "utf8"));
    assert.equal(repaired.dims.companion, 0.01);
    assert.equal(typeof repaired.updatedAt, "string");
  });
});

describe("接线：genome_status / prompt / 人工确认", () => {
  test("genome_status 工具返回 5 维 + 世代 + 是否有待批提案（只读）", async () => {
    const { createUnifiedToolExecutor } = await import("../../engine/tools/unified-tools.mjs");
    const root = fresh({ dims: ALL_ONE });
    advance({});
    const execute = createUnifiedToolExecutor({});
    const out = await execute("genome_status", {}, {});
    assert.notEqual(out.isError, true);
    const parsed = JSON.parse(out.text);
    assert.equal(Object.keys(parsed["成长"]["dims"]).length, 5);
    assert.equal(parsed["成长"]["generation"], 0);
    assert.equal(parsed["成长"]["hasPending"], true);
    assert.ok(parsed["成长"]["pending"]);
    assert.equal(parsed["世代"], 0);

    // 只读：调用工具不得改动成长台账
    const before = fs.readFileSync(stateFile(root), "utf8");
    await execute("genome_status", {}, {});
    assert.equal(fs.readFileSync(stateFile(root), "utf8"), before, "genome_status 不得写文件");
  });

  test("prompt 只多一行「成长：」，与「人格漂移」并列在同一块 system 里", async () => {
    const emotion = await import("../../engine/emotion.mjs");
    const { beginYuanshuEmotion } = await import("../../engine/yuanshu-emotion.mjs");
    const root = tmpRoot();
    fs.mkdirSync(dirOf(root), { recursive: true });
    init(root);
    emotion.init(root);
    const history = beginYuanshuEmotion("growth-line", "你好", []);
    const text = history.filter((m) => m.role === "system").map((m) => String(m.content || "")).join("\n");
    assert.equal((text.match(/成长：/g) || []).length, 1, "成长摘要只能出现一次");
    assert.equal((text.match(/人格漂移：/g) || []).length, 1, "人格漂移摘要也只能出现一次");
    assert.ok(text.indexOf("成长：") > text.indexOf("人格漂移："), "成长紧跟在人格漂移后面，不另起一段");
    // 同一块里已经有两行时不再重复注入
    const again = beginYuanshuEmotion("growth-line", "你好", history);
    assert.equal(again, history);
  });

  test("人工确认接线：批准才换代，approvedBy 由服务端铸；拒绝/无会话都改不动", async () => {
    const api = { status: (o) => status(o), promote, rollback };
    const makeRegistry = (outcome) => {
      const calls = [];
      return {
        calls,
        register(sid, payload) {
          calls.push({ sid, payload });
          return { id: `c${calls.length}`, promise: Promise.resolve(outcome), sessionId: sid };
        },
        settle() { return { ok: true }; },
      };
    };
    const run = (action, body, outcome = "allowed-once") => createGrowthApproval({
      api,
      registry: makeRegistry(outcome),
      sessionExists: (sid) => sid === "s1",
      push: () => {},
    })(action, body);

    fresh({ dims: ALL_ONE });
    advance({});

    const noSession = await run("promote", { reason: "x" });
    assert.equal(noSession.code, "confirmation_required");
    assert.equal(current().generation, 0);

    const deniedOutcome = await run("promote", { sessionId: "s1", reason: "x" }, "rejected");
    assert.equal(deniedOutcome.code, "confirmation_denied");
    assert.equal(current().generation, 0);

    const ok = await run("promote", { sessionId: "s1", reason: "批准换代" });
    assert.equal(ok.promoted, true);
    const st = current();
    assert.equal(st.generation, 1);
    assert.equal(st.generations[0].approvedBy, "human-confirm:s1:c1", "approvedBy 必须由确认流程铸出来");
    assert.equal(st.history.at(-1).action, "promote");
  });
});
