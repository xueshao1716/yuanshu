// GRN 基因网络 + 漂移阈值（2026-11-09，曦 heart.py/grn.py 移植）
// 锁住：公式与硬边界、单调性、3 轮收敛、漂移阈值、基线采纳、落盘降级、一行 prompt、体检红线。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GENES, GENE_LABELS, GENE_BOUNDS, GENE_SPECS, SIGNALS, CLUSTERS,
  DEFAULT_BASELINE, DEFAULT_SIGNALS, CONVERGENCE_EPS,
  init, current, express, regulate, drift, promptLine, status, statusText,
  setBaseline, adoptBaseline, advanceTurn, recordGuardBlock, driftWarnings,
  noveltyFromGap, nextStress,
} from "../../engine/genome.mjs";
import { init as initRelationship } from "../../engine/relationship.mjs";

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "genome-"));
const dirOf = (root) => path.join(root, "记忆", "运行时");
const stateFile = (root) => path.join(dirOf(root), "基因.json");

function seedGenome(root, patch = {}) {
  fs.mkdirSync(dirOf(root), { recursive: true });
  fs.writeFileSync(stateFile(root), JSON.stringify({ generation: 0, ...patch }), "utf8");
}

function seedRelationship(root, { trust = 0.8, intimacy = 0.7 } = {}) {
  fs.mkdirSync(dirOf(root), { recursive: true });
  fs.writeFileSync(path.join(dirOf(root), "关系.json"), JSON.stringify({
    trust, intimacy, interactions: 3, notes: [], firstSeen: null, lastAt: null,
  }), "utf8");
  initRelationship(root);
}

function fresh(seed = null) {
  const root = tmpRoot();
  if (seed) seedGenome(root, seed);
  init(root);
  return root;
}

const within = (genes) => GENES.every((g) => genes[g] >= GENE_BOUNDS[g].lower - 1e-9 && genes[g] <= GENE_BOUNDS[g].upper + 1e-9);

describe("基因表（heart.py 公式 + 硬边界）", () => {
  test("10 基因 × 4 信号，导出里有中文标签、公式、上下界", () => {
    assert.equal(GENES.length, 10);
    assert.deepEqual(SIGNALS, ["intimacy", "novelty", "stress", "trust"]);
    for (const g of GENES) {
      assert.equal(typeof GENE_LABELS[g], "string");
      assert.equal(typeof GENE_SPECS[g].formula, "string");
      assert.ok(GENE_BOUNDS[g].lower < GENE_BOUNDS[g].upper);
      assert.ok(["core_identity", "cognitive", "expressive", "governance"].includes(GENE_SPECS[g].cluster));
    }
    assert.equal(new Set(GENES.map((g) => GENE_SPECS[g].cluster)).size, 4);
  });

  test("4 信号 16 种 0/1 组合：10 个值全部落在各自 bounds 内", () => {
    init(tmpRoot());
    for (let mask = 0; mask < 16; mask++) {
      const signals = {
        intimacy: mask & 1 ? 1 : 0,
        novelty: mask & 2 ? 1 : 0,
        stress: mask & 4 ? 1 : 0,
        trust: mask & 8 ? 1 : 0,
      };
      const genes = express(signals);
      assert.equal(Object.keys(genes).length, 10);
      assert.ok(within(genes), `组合 ${mask} 越界：${JSON.stringify(genes)}`);
      for (const g of GENES) assert.ok(genes[g] >= 0 && genes[g] <= 1);
    }
  });

  test("公式逐项对得上：亲密/信任/压力取边界时的温柔、谨慎、忠诚", () => {
    init(tmpRoot());
    const high = express({ intimacy: 1, novelty: 1, stress: 0, trust: 1 });
    assert.equal(high.gentleness, 0.75);       // .5 + .15 + .10 - 0
    assert.equal(high.attachment, 0.72);       // .5 + .12 + .10
    assert.equal(high.caution, 0.5);           // 压力 0
    assert.equal(high.loyalty, 0.5);           // 不随信号变
    const stressed = express({ intimacy: 0, novelty: 0, stress: 1, trust: 0 });
    assert.equal(stressed.caution, 0.7);       // .5 + .20
    assert.equal(stressed.initiative, 0.32);   // .5 - .18
    assert.equal(stressed.learning, 0.5);      // .5 + 0 + 0
  });

  test("单调性：亲密↑ 温柔/依恋/幽默↑；新奇↑ 好奇/创造/学习↑；压力↑ 谨慎↑、主动↓", () => {
    init(tmpRoot());
    const low = express({ intimacy: 0, novelty: 0.5, stress: 0.2, trust: 0 });
    const high = express({ intimacy: 1, novelty: 0.5, stress: 0.2, trust: 0 });
    for (const g of ["gentleness", "attachment", "humor"]) assert.ok(high[g] > low[g], `${g} 应随亲密上升`);
    assert.equal(high.loyalty, low.loyalty, "忠诚不随信号变");

    const n0 = express({ intimacy: 0.5, novelty: 0, stress: 0.2, trust: 0.5 });
    const n1 = express({ intimacy: 0.5, novelty: 1, stress: 0.2, trust: 0.5 });
    for (const g of ["curiosity", "creativity", "learning", "initiative", "autonomy_bias"]) {
      assert.ok(n1[g] > n0[g], `${g} 应随新奇上升`);
    }

    const s0 = express({ intimacy: 0.5, novelty: 0.5, stress: 0, trust: 0.5 });
    const s1 = express({ intimacy: 0.5, novelty: 0.5, stress: 1, trust: 0.5 });
    assert.ok(s1.caution > s0.caution, "谨慎应随压力上升");
    for (const g of ["initiative", "gentleness", "humor", "autonomy_bias", "learning"]) {
      assert.ok(s1[g] < s0[g], `${g} 应随压力下降`);
    }
  });

  test("极端 baseline 也被硬边界夹住（不会贴死 0/1）", () => {
    init(tmpRoot());
    const genes = express({ intimacy: 1, novelty: 1, stress: 0, trust: 1 }, { baseline: Object.fromEntries(GENES.map((g) => [g, 0.99])) });
    assert.ok(within(genes));
    assert.equal(genes.gentleness, 0.95);
    assert.equal(genes.caution, 0.9);
    assert.equal(genes.loyalty, 0.99);
  });

  test("坏信号输入降级：越界夹紧、NaN 用默认压力 0.1、非数字用 0.5", () => {
    init(tmpRoot());
    const genes = express({ intimacy: 2, novelty: -1, stress: NaN, trust: "x" });
    assert.ok(Math.abs(genes.gentleness - 0.69) < 1e-9);
    assert.equal(genes.curiosity, 0.5);
    assert.ok(within(genes));
  });
});

describe("regulate：up/down 互相压制，3 轮收敛", () => {
  test("3 轮：相邻差递减、末轮 ≤ eps、每轮值不越界", () => {
    init(tmpRoot());
    const r = regulate({ signals: { intimacy: 0.9, novelty: 0.8, stress: 0.1, trust: 0.8 }, iterations: 3 });
    assert.equal(r.rounds.length, 3);
    assert.equal(r.eps, CONVERGENCE_EPS);
    const [d1, d2, d3] = r.rounds.map((x) => x.maxDelta);
    assert.ok(d2 < d1, `第 2 轮应比第 1 轮小：${d1} → ${d2}`);
    assert.ok(d3 < d2, `第 3 轮应比第 2 轮小：${d2} → ${d3}`);
    assert.ok(d3 <= CONVERGENCE_EPS, `第 3 轮相邻差 ${d3} 应 ≤ ${CONVERGENCE_EPS}`);
    assert.equal(r.converged, true);
    for (const round of r.rounds) assert.ok(within(round.genes), "调控中间值也必须落在 bounds 内");
    assert.ok(within(r.genes));
  });

  test("四组极端信号都能在 3 轮内收敛", () => {
    init(tmpRoot());
    const sets = [
      { intimacy: 1, novelty: 1, stress: 0, trust: 1 },
      { intimacy: 0, novelty: 0, stress: 1, trust: 0 },
      { intimacy: 0, novelty: 1, stress: 1, trust: 0 },
      { intimacy: 1, novelty: 0, stress: 0, trust: 1 },
    ];
    for (const signals of sets) {
      const r = regulate({ signals, iterations: 3 });
      assert.ok(r.converged, `${JSON.stringify(signals)} 未收敛：${r.rounds.map((x) => x.maxDelta)}`);
      assert.ok(within(r.genes));
    }
  });

  test("iterations 可调：1 轮返回 1 组值，5 轮仍不越界", () => {
    init(tmpRoot());
    const one = regulate({ signals: DEFAULT_SIGNALS, iterations: 1 });
    assert.equal(one.rounds.length, 1);
    const five = regulate({ signals: DEFAULT_SIGNALS, iterations: 5 });
    assert.equal(five.rounds.length, 5);
    assert.ok(within(five.genes));
  });

  test("调控确实改变公式值，而不是原样返回", () => {
    init(tmpRoot());
    const base = express({ intimacy: 0.9, novelty: 0.8, stress: 0.1, trust: 0.8 });
    const r = regulate({ genes: base, signals: { intimacy: 0.9, novelty: 0.8, stress: 0.1, trust: 0.8 }, iterations: 3 });
    assert.notDeepEqual(r.genes, base);
    assert.ok(GENES.some((g) => Math.abs(r.genes[g] - base[g]) > 0.01));
  });
});

describe("drift：对照 baseline 的簇漂移与阈值", () => {
  test("改动一个 core_identity 基因：该簇漂移上升、超 0.15、withinAll=false", () => {
    const root = fresh({
      genes: { ...DEFAULT_BASELINE, loyalty: 1.0 },
      baseline: { ...DEFAULT_BASELINE },
    });
    const d = drift();
    assert.equal(d.clusters.core_identity.drift, 0.1667); // 0.5 / 3 个基因
    assert.equal(d.clusters.core_identity.threshold, 0.15);
    assert.equal(d.clusters.core_identity.within, false);
    assert.equal(d.clusters.core_identity.genes.loyalty, 0.5);
    assert.equal(d.withinAll, false);
    assert.equal(d.worst.key, "core_identity");
    // 其它簇没动
    assert.equal(d.clusters.cognitive.drift, 0);
    assert.equal(d.clusters.governance.within, true);
  });

  test("漂移小的改动仍在阈值内（平均绝对距离，不是单个基因的欧氏放大）", () => {
    fresh({ genes: { ...DEFAULT_BASELINE, loyalty: 0.7 }, baseline: { ...DEFAULT_BASELINE } });
    const d = drift();
    assert.equal(d.clusters.core_identity.drift, 0.0667); // 0.2 / 3
    assert.equal(d.clusters.core_identity.within, true);
    assert.equal(d.withinAll, true);
  });

  test("四个簇的阈值与 grn.py 一致：0.15 / 0.20 / 0.18 / 0.12", () => {
    fresh();
    const d = drift();
    assert.equal(d.clusters.core_identity.threshold, 0.15);
    assert.equal(d.clusters.cognitive.threshold, 0.20);
    assert.equal(d.clusters.expressive.threshold, 0.18);
    assert.equal(d.clusters.governance.threshold, 0.12);
    assert.equal(Object.keys(CLUSTERS).length, 4);
  });

  test("认知簇整体抬高（硬上限 0.95）→ 0.45/0.20 超阈值，withinAll=false", () => {
    fresh({
      genes: { ...DEFAULT_BASELINE, learning: 1, curiosity: 1, creativity: 1 },
      baseline: { ...DEFAULT_BASELINE },
    });
    const d = drift();
    assert.equal(d.clusters.cognitive.drift, 0.45); // 三个基因都被 upper=0.95 夹住：(0.45×3)/3
    assert.equal(d.clusters.cognitive.within, false);
    assert.equal(d.withinAll, false);
  });
});

describe("baseline：人批准后把当前值定为新基线", () => {
  test("adoptBaseline() 后漂移归零，approvedBy 回传留痕", () => {
    fresh({ genes: Object.fromEntries(GENES.map((g) => [g, 0.62])), baseline: { ...DEFAULT_BASELINE } });
    const out = adoptBaseline({ approvedBy: "伙伴" });
    assert.equal(out.ok, true);
    assert.equal(out.approvedBy, "伙伴");
    const d = drift();
    for (const c of Object.values(d.clusters)) assert.equal(c.drift, 0);
    assert.equal(d.withinAll, true);
    assert.equal(current().baseline.gentleness, 0.62);
  });

  test("setBaseline(genes) 显式设定，并夹在硬边界内", () => {
    fresh();
    setBaseline({ gentleness: 2, caution: -1, loyalty: 0.5 });
    const b = current().baseline;
    assert.equal(b.gentleness, GENE_BOUNDS.gentleness.upper);
    assert.equal(b.caution, GENE_BOUNDS.caution.lower);
    assert.equal(b.loyalty, 0.5);
    // 没给的基因回落到当前基线（默认 0.5）
    assert.equal(b.curiosity, 0.5);
  });
});

describe("落盘 / 读回 / 坏文件降级", () => {
  test("advanceTurn 原子写入 记忆/运行时/基因.json，读回一致", () => {
    const root = tmpRoot();
    init(root);
    const t = Date.parse("2026-11-09T12:00:00Z");
    const out = advanceTurn({ toolFailures: 0, now: t });
    assert.ok(fs.existsSync(stateFile(root)));
    const saved = JSON.parse(fs.readFileSync(stateFile(root), "utf8"));
    for (const k of ["genes", "signals", "generation", "baseline", "updatedAt"]) assert.ok(k in saved, `缺字段 ${k}`);
    assert.equal(saved.updatedAt, new Date(t).toISOString());

    init(""); init(root);
    assert.deepEqual(current().genes, saved.genes);
    assert.deepEqual(current().signals, saved.signals);
    assert.equal(out.state.genes.gentleness, saved.genes.gentleness);
  });

  test("坏 JSON 降级默认值，不抛；下一轮写盘修复成合法 JSON", () => {
    const root = tmpRoot();
    fs.mkdirSync(dirOf(root), { recursive: true });
    fs.writeFileSync(stateFile(root), "{ this is not json", "utf8");
    init(root);
    const st = current();
    assert.deepEqual(st.genes, { ...DEFAULT_BASELINE });
    assert.equal(st.generation, 0);
    assert.equal(drift().withinAll, true);

    advanceTurn({ toolFailures: 0 });
    const repaired = JSON.parse(fs.readFileSync(stateFile(root), "utf8"));
    assert.equal(typeof repaired.genes.gentleness, "number");
    assert.ok(within(repaired.genes));
  });

  test("状态文件里缺基因 / 越界值 → 读回时补齐并夹紧", () => {
    fresh({ genes: { gentleness: 0.99, loyalty: -5 }, baseline: { ...DEFAULT_BASELINE } });
    const st = current();
    assert.equal(st.genes.gentleness, 0.95);
    assert.equal(st.genes.loyalty, GENE_BOUNDS.loyalty.lower);
    assert.equal(st.genes.curiosity, 0.5);
  });
});

describe("prompt 注入：只有一行", () => {
  test("正常时一行，格式与示例一致", () => {
    fresh();
    const line = promptLine();
    assert.equal(line, "基因：core_identity 漂移 0.00/0.15（正常）");
    assert.equal(line.includes("\n"), false);
  });

  test("超阈值时明确告警 + 建议，仍在同一行", () => {
    fresh({
      genes: { ...DEFAULT_BASELINE, learning: 1, curiosity: 1, creativity: 1 },
      baseline: { ...DEFAULT_BASELINE },
    });
    const line = promptLine();
    assert.equal(line, "基因告警：认知簇（cognitive）偏离 0.45/0.20，建议复看最近经历。");
    assert.equal(line.includes("\n"), false);
  });

  test("多个簇超阈值时全部列出，用顿号连接", () => {
    fresh({
      genes: { ...DEFAULT_BASELINE, loyalty: 1, learning: 1, curiosity: 1, creativity: 1 },
      baseline: { ...DEFAULT_BASELINE },
    });
    const line = promptLine();
    assert.ok(line.includes("核心认同簇（core_identity）"));
    assert.ok(line.includes("认知簇（cognitive）"));
    assert.ok(line.includes("、"));
    assert.ok(line.includes("建议复看最近经历"));
  });
});

describe("genome_status：只读状态", () => {
  test("返回 10 基因、4 信号、4 簇、世代号与一行摘要", () => {
    fresh();
    const s = status();
    assert.equal(Object.keys(s.genes).length, 10);
    assert.equal(Object.keys(s.signals).length, 4);
    assert.equal(Object.keys(s.clusters).length, 4);
    assert.equal(s.generation, 0);
    assert.equal(s.labels.gentleness, "温柔");
    assert.equal(s.clusters.core_identity.threshold, 0.15);
    assert.equal(typeof s.prompt, "string");
    assert.ok(Array.isArray(s.warnings));
    const text = statusText();
    const parsed = JSON.parse(text);
    assert.equal(Object.keys(parsed["基因"]).length, 10);
    assert.equal(Object.keys(parsed["簇"]).length, 4);
    assert.equal(parsed["世代"], 0);
  });
});

describe("信号来源：关系 + 失败计数 + 时间间隔 + 红线拦截", () => {
  test("intimacy/trust 取自 relationship（不是写死常量）", () => {
    const root = tmpRoot();
    init(root);
    seedRelationship(root, { trust: 0.9, intimacy: 0.8 });
    const out = advanceTurn({ toolFailures: 0, now: Date.parse("2026-11-09T12:00:00Z") });
    assert.equal(out.state.signals.trust, 0.9);
    assert.equal(out.state.signals.intimacy, 0.8);
  });

  test("本轮工具失败 → stress 上升；下一轮成功 → 回落", () => {
    const root = tmpRoot();
    init(root);
    const failed = advanceTurn({ toolFailures: 2, now: Date.parse("2026-11-09T12:00:00Z") });
    assert.ok(failed.state.signals.stress > 0.4, `失败后压力应上升，实际 ${failed.state.signals.stress}`);
    const recovered = advanceTurn({ toolFailures: 0, now: Date.parse("2026-11-09T12:01:00Z") });
    assert.ok(recovered.state.signals.stress < failed.state.signals.stress, "成功后压力应回落");
  });

  test("红线拦截计入 stress：recordGuardBlock 后下一轮压力更高，并且结算后清零", () => {
    const root = tmpRoot();
    init(root);
    const base = advanceTurn({ toolFailures: 0, now: Date.parse("2026-11-09T12:00:00Z") });
    const root2 = tmpRoot();
    init(root2);
    recordGuardBlock({ count: 2 });
    const blocked = advanceTurn({ toolFailures: 0, now: Date.parse("2026-11-09T12:00:00Z") });
    assert.equal(blocked.guardBlocks, 2);
    assert.ok(blocked.state.signals.stress > base.state.signals.stress, "被红线拦过的一轮压力应更高");
    const next = advanceTurn({ toolFailures: 0, now: Date.parse("2026-11-09T12:01:00Z") });
    assert.equal(next.guardBlocks, 0);
  });

  test("novelty 是时间间隔代理：隔 24 小时 > 隔 1 分钟", () => {
    const root = tmpRoot();
    init(root);
    const t = Date.parse("2026-11-09T00:00:00Z");
    advanceTurn({ now: t });
    const short = advanceTurn({ now: t + 60_000 }).state.signals.novelty;
    const long = advanceTurn({ now: t + 24 * 3600_000 }).state.signals.novelty;
    assert.ok(long > short, `24h 的新奇 ${long} 应大于 1min 的 ${short}`);
    assert.ok(short > 0 && long <= 1);
  });

  test("noveltyFromGap / nextStress 是纯函数，边界可复现", () => {
    assert.equal(noveltyFromGap(null), 0.5);
    assert.ok(noveltyFromGap(new Date(0).toISOString(), 24 * 3600_000) > noveltyFromGap(new Date(0).toISOString(), 0));
    assert.equal(nextStress(0, 0, 0), 0);
    assert.equal(nextStress(0, 1, 0), 0.4);
    assert.equal(nextStress(0, 0, 2), 0.3);
    assert.equal(nextStress(0, 5, 5), 0.7);
  });
});

describe("driftWarnings：可自动判定的体检红线", () => {
  test("autonomy_bias < 0.40 → 依赖/表演独立", () => {
    fresh({ genes: { ...DEFAULT_BASELINE, autonomy_bias: 0.3 } });
    const w = driftWarnings({ genes: { autonomy_bias: 0.3, attachment: 0.35 } }, {});
    assert.ok(w.some((s) => s.includes("自主性偏低")), w.join("\n"));
  });

  test("attachment（陪伴代理）比 autonomy_bias 高 >0.30 → 取悦驱动", () => {
    const w = driftWarnings({ genes: { autonomy_bias: 0.45, attachment: 0.85 } }, {});
    assert.ok(w.some((s) => s.includes("取悦驱动")), w.join("\n"));
    assert.ok(w.some((s) => s.includes("陪伴代理")), "要注明 companion 用的是 attachment 代理");
  });

  test("同一情绪 >80%（≥8 条样本）→ 脚本化", () => {
    const w = driftWarnings({ genes: { ...DEFAULT_BASELINE } }, { emotions: [...Array(9).fill("calm"), "curious"] });
    assert.ok(w.some((s) => s.includes("情绪脚本化") && s.includes("「calm」占 90%")), w.join("\n"));
  });

  test("簇漂移超阈值 → 建议复看最近经历", () => {
    const w = driftWarnings({
      genes: { ...DEFAULT_BASELINE, learning: 1, curiosity: 1, creativity: 1 },
      baseline: { ...DEFAULT_BASELINE },
    }, {});
    assert.ok(w.some((s) => s.includes("认知簇（cognitive）") && s.includes("建议复看最近经历")), w.join("\n"));
  });

  test("零主动行为 / 反思停滞在拿到数据时才判", () => {
    const w = driftWarnings({ genes: { ...DEFAULT_BASELINE } }, { proactiveActions: 0, reflectionCount: 1 });
    assert.ok(w.some((s) => s.includes("零主动行为")));
    assert.ok(w.some((s) => s.includes("反思停滞")));
    const skipped = driftWarnings({ genes: { ...DEFAULT_BASELINE } }, {});
    assert.ok(skipped.some((s) => s.includes("（跳过）主动行为")));
    assert.ok(skipped.some((s) => s.includes("（跳过）反思次数")));
  });

  test("拿不到的数据项跳过并注明；纯函数不改输入", () => {
    const state = { genes: { autonomy_bias: 0.6, attachment: 0.5 }, baseline: { ...DEFAULT_BASELINE } };
    const before = JSON.stringify(state);
    const w = driftWarnings(state, {});
    assert.ok(w.some((s) => s.includes("（跳过）情绪分布")));
    assert.equal(JSON.stringify(state), before, "driftWarnings 不应改输入");
    // 健康状态不出现告警，只出现跳过说明
    assert.equal(w.some((s) => s.includes("超阈值") || s.includes("自主性偏低") || s.includes("取悦驱动")), false);
  });

  test("情绪样本不足 8 条时明确跳过而不是下结论", () => {
    const w = driftWarnings({ genes: { ...DEFAULT_BASELINE } }, { emotions: ["calm", "calm"] });
    assert.ok(w.some((s) => s.includes("（跳过）情绪分布") && s.includes("只有 2 条样本")));
  });
});
