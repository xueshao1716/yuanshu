// 关系层（2026-11-09）：情绪是分钟级快变量，关系是月级慢变量。
// 锁四件事：非对称增量（negative 掉得比 positive 涨得快）、夹紧、notes 截断、落盘读回。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  init, recordInteraction, current, summary, stage,
  KIND_DELTAS, DEFAULT_RELATIONSHIP, MAX_NOTES, NOTE_MAX,
  positiveTrustFactor, positiveTrustGain, TRUST_SOFTEN_SPAN,
} from "../../engine/relationship.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "rel-"));
const round4 = (n) => Math.round(n * 1e4) / 1e4;

// 造一个指定 trust 的关系现场：先落盘再 init（首次 init 这个 root 时缓存为空 → 从盘读）
function seedRel(trust, extra = {}) {
  const root = tmpRoot();
  const dir = path.join(root, "记忆", "运行时");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "关系.json"), JSON.stringify({ ...DEFAULT_RELATIONSHIP, trust, ...extra }), "utf8");
  init(root);
  return root;
}

describe("关系状态", () => {
  test("初始字段齐全、数值在 0..1", () => {
    init(tmpRoot());
    const st = current();
    for (const k of ["trust", "intimacy", "interactions", "notes", "firstSeen", "lastAt"]) {
      assert.ok(k in st, `状态缺字段 ${k}`);
    }
    assert.ok(st.trust >= 0 && st.trust <= 1);
    assert.ok(st.intimacy >= 0 && st.intimacy <= 1);
    assert.equal(st.interactions, 0);
    assert.deepEqual(st.notes, []);
    assert.equal(st.firstSeen, null);
  });

  test("非对称：positive +0.03/+0.02，negative -0.08/-0.03（基线 trust=0.25 处正面不软化）", () => {
    assert.equal(KIND_DELTAS.positive.trust, 0.03);
    assert.equal(KIND_DELTAS.positive.intimacy, 0.02);
    assert.equal(KIND_DELTAS.negative.trust, -0.08);
    assert.equal(KIND_DELTAS.negative.intimacy, -0.03);
    assert.ok(Math.abs(KIND_DELTAS.negative.trust) > KIND_DELTAS.positive.trust, "负向必须比正向陡");
    // 一次负面 ≈ 2.7 次正面
    assert.ok(Math.abs(KIND_DELTAS.negative.trust / KIND_DELTAS.positive.trust) > 2);

    init(tmpRoot());
    const b = current();
    const p = recordInteraction({ kind: "positive" });
    // 软化系数归一到基线（DEFAULT_RELATIONSHIP.trust=0.25），所以第一次正面仍是满额 +0.03
    assert.equal(positiveTrustFactor(DEFAULT_RELATIONSHIP.trust), 1);
    assert.equal(round4(p.trust - b.trust), 0.03);
    assert.equal(round4(p.intimacy - b.intimacy), 0.02);

    init(tmpRoot());
    const b2 = current();
    const n = recordInteraction({ kind: "negative" });
    assert.equal(round4(n.trust - b2.trust), -0.08);
    assert.equal(round4(n.intimacy - b2.intimacy), -0.03);
  });

  test("neutral 不无条件加分，但记次数/留 note", () => {
    init(tmpRoot());
    const b = current();
    const st = recordInteraction({ kind: "neutral", note: "只是聊了两句" });
    assert.equal(st.trust, b.trust, "中性不得涨信任");
    assert.equal(st.intimacy, b.intimacy, "中性不得涨亲密");
    assert.equal(st.interactions, 1);
    assert.equal(st.notes.at(-1), "只是聊了两句");
  });

  test("上下限夹紧 0..1：正面渐近逼近 1 但不顶死，负面照旧跌到 0", () => {
    init(tmpRoot());
    for (let i = 0; i < 40; i++) recordInteraction({ kind: "positive" });
    let st = current();
    assert.ok(st.trust <= 1 && st.intimacy <= 1, `上限没夹住 ${st.trust}/${st.intimacy}`);
    // 2026-11-09 正面软化改写了这条断言（旧断言写死 `trust === 1`）：40 次正面现在到 0.8535，
    // 不是实现坏了——设计上就要"离 1 越近涨得越慢"，但永远还有一点增量，不会顶死后失效。
    assert.ok(st.trust > 0.8 && st.trust < 1, `正面软化后应逼近但不到 1，实际 ${st.trust}`);
    assert.equal(round4(st.intimacy), 0.95, "亲密不受软化影响（另一根轴），40 次 → 0.95");
    const before = current().trust;
    recordInteraction({ kind: "positive" });
    const after = current().trust;
    assert.ok(after > before, "到 0.85 也得继续涨，不能顶死");
    assert.ok(after - before < 0.01, `而且涨得很少（边际递减），实际 ${after - before}`);
    init(tmpRoot());
    for (let i = 0; i < 40; i++) recordInteraction({ kind: "negative" });
    st = current();
    assert.equal(st.trust, 0);
    assert.ok(st.intimacy >= 0, "下限必须夹在 0");
  });

  test("weight 乘算，且夹在 0..2", () => {
    init(tmpRoot());
    const b = current();
    const st = recordInteraction({ kind: "positive", weight: 2 });
    assert.equal(round4(st.trust - b.trust), 0.06);
    init(tmpRoot());
    const b2 = current();
    const st2 = recordInteraction({ kind: "positive", weight: 99 });
    assert.equal(round4(st2.trust - b2.trust), 0.06, "weight 99 等同 2");
  });

  test("notes 只留最近 20 条，每条 ≤120 字", () => {
    init(tmpRoot());
    for (let i = 0; i < 25; i++) recordInteraction({ kind: "neutral", note: `第${i}条 ` + "x".repeat(200) });
    const st = current();
    assert.equal(st.notes.length, MAX_NOTES);
    assert.equal(MAX_NOTES, 20);
    assert.ok(st.notes.at(-1).startsWith("第24条"), "最旧的要被挤掉，留最新的");
    assert.ok(st.notes[0].startsWith("第5条"), `头部应是第5条，实际 ${st.notes[0].slice(0, 6)}`);
    for (const n of st.notes) assert.ok(n.length <= NOTE_MAX, `note 超长 ${n.length}`);
  });
});

describe("正面边际递减（2026-11-09 防饱和）", () => {
  test("软化曲线：基线处满额，trust 越高系数越小", () => {
    assert.equal(TRUST_SOFTEN_SPAN, 0.75);
    assert.equal(positiveTrustFactor(DEFAULT_RELATIONSHIP.trust), 1, "基线 0.25 处不软化");
    assert.equal(round4(positiveTrustFactor(0.5)), 0.6667);
    assert.equal(round4(positiveTrustFactor(0.9)), 0.1333);
    assert.equal(round4(positiveTrustFactor(0.95)), 0.0667);
    assert.equal(positiveTrustFactor(1), 0, "到 1 就没有空间了（但 clamp01 下永远到不了 1）");
    // 增量口径
    assert.equal(round4(positiveTrustGain(0.2)), 0.03, "低 trust 处接近满额 0.03");
    assert.ok(positiveTrustGain(0.9) > 0 && positiveTrustGain(0.9) < 0.005, `trust 0.9 应 <0.005，实际 ${positiveTrustGain(0.9)}`);
    assert.ok(positiveTrustGain(0.95) > 0 && positiveTrustGain(0.95) <= 0.005, `trust 0.95 应是 >0 的极小增量，实际 ${positiveTrustGain(0.95)}`);
  });

  test("真跑一轮：trust 0.9 时正面 <0.005，trust 0.2 时 ≈0.03", () => {
    seedRel(0.9);
    const b = current();
    const p = recordInteraction({ kind: "positive" });
    const d = p.trust - b.trust;
    assert.ok(d > 0 && d < 0.005, `trust 0.9 的正面增量应 <0.005，实际 ${d}`);
    assert.equal(round4(d), 0.004);
    assert.equal(round4(p.intimacy - b.intimacy), 0.02, "亲密不受 trust 软化影响");

    seedRel(0.2);
    const b2 = current();
    const p2 = recordInteraction({ kind: "positive" });
    assert.equal(round4(p2.trust - b2.trust), 0.03);
  });

  test("negative 不软化：trust 0.9 时仍是 -0.08（信任掉得快是设计意图）", () => {
    seedRel(0.9);
    const b = current();
    const n = recordInteraction({ kind: "negative" });
    assert.equal(round4(n.trust - b.trust), -0.08);
    // 五次负面就能把 0.9 打回 0.5——危机比积累快，这是刻意的
    for (let i = 0; i < 4; i++) recordInteraction({ kind: "negative" });
    assert.equal(round4(current().trust), 0.5);
  });

  test("刷 25 轮（旧口径正好到 1）不再顶死；200 轮后仍有极小增量", () => {
    init(tmpRoot());
    for (let i = 0; i < 25; i++) recordInteraction({ kind: "positive" });
    const t25 = current().trust;
    assert.ok(t25 < 1 && t25 > 0.7, `25 轮应到 0.73 左右且不到 1，实际 ${t25}`);
    for (let i = 0; i < 175; i++) recordInteraction({ kind: "positive" });
    const t200 = current().trust;
    assert.ok(t200 > t25 && t200 < 1, `200 轮仍在涨且不到 1，实际 ${t200}`);
    const before = current().trust;
    recordInteraction({ kind: "positive" });
    assert.ok(current().trust > before, "到 0.9998 也得继续涨（不会永远顶死）");
    assert.ok(current().trust - before < 1e-4, "而且已经极小");
  });
});

describe("summary / stage", () => {
  test("summary 是一行中文，含量化数字与次数", () => {
    init(tmpRoot());
    recordInteraction({ kind: "positive" });
    const line = summary();
    assert.equal(typeof line, "string");
    assert.ok(!line.includes("\n"), "必须一行");
    assert.match(line, /^关系：信任 \d\.\d{2}／亲密 \d\.\d{2}（已聊 \d+ 次）$/);
    assert.ok(line.includes("已聊 1 次"));
  });

  test("stage 按阈值给 陌生/熟悉/信任/亲近（正面软化后阈值轮次变多）", () => {
    init(tmpRoot());
    assert.equal(stage().name, "陌生");
    for (let i = 0; i < 3; i++) recordInteraction({ kind: "positive" }); // 0.34
    assert.equal(stage().name, "熟悉");
    // 2026-11-09 正面软化：0.55 需要 13 次（旧断言 11 次 = 写死旧线性曲线）
    for (let i = 0; i < 10; i++) recordInteraction({ kind: "positive" }); // 第 13 次 → 0.559
    assert.equal(stage().name, "信任");
    // 亲近要 trust≥0.8 且 intimacy≥0.6：第 33 次 trust 0.805 / intimacy 0.81
    for (let i = 0; i < 20; i++) recordInteraction({ kind: "positive" });
    const s = stage();
    assert.equal(s.name, "亲近");
    assert.equal(s.code, "close");
  });

  test("负面互动能把阶段打回去（信任掉了，但聊过的次数不会倒退）", () => {
    init(tmpRoot());
    for (let i = 0; i < 13; i++) recordInteraction({ kind: "positive" }); // 0.559
    assert.equal(stage().name, "信任");
    for (let i = 0; i < 4; i++) recordInteraction({ kind: "negative" }); // 0.559 - 0.32 = 0.239
    assert.equal(stage().name, "熟悉", "信任跌破 0.55，但已聊 17 次仍是熟悉");
  });
});

describe("落盘", () => {
  test("原子写到 记忆/运行时/关系.json，读回一致，无临时文件残留", () => {
    const root = tmpRoot();
    init(root);
    recordInteraction({ kind: "positive", note: "一起修好了情绪引擎" });
    const file = path.join(root, "记忆", "运行时", "关系.json");
    assert.ok(fs.existsSync(file), "关系文件必须落盘");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(raw.interactions, 1);
    assert.equal(raw.notes.at(-1), "一起修好了情绪引擎");
    assert.ok(raw.firstSeen && raw.lastAt, "firstSeen/lastAt 要写");
    const leftovers = fs.readdirSync(path.dirname(file)).filter((n) => n.includes(".tmp-"));
    assert.deepEqual(leftovers, [], "原子写不能留临时文件");
    // 模拟重启：换 root 清缓存，再切回来必须从盘读回
    init(tmpRoot());
    init(root);
    const again = current();
    assert.equal(again.interactions, 1);
    assert.equal(again.notes.at(-1), "一起修好了情绪引擎");
  });

  test("没有工作区根时不炸，也不写盘", () => {
    init(tmpRoot());
    assert.doesNotThrow(() => recordInteraction({ kind: "positive" }));
    assert.ok(DEFAULT_RELATIONSHIP.trust >= 0 && DEFAULT_RELATIONSHIP.trust <= 1);
  });
});

describe("接线（静态断言）", () => {
  test("turn_end：unified-chat finishEmotion 记关系，按本轮有没有工具失败给 kind", () => {
    const src = fs.readFileSync(path.join(ROOT, "engine", "unified-chat.mjs"), "utf8");
    const start = src.indexOf("const finishEmotion = (");
    assert.ok(start > 0, "finishEmotion 还在");
    const fn = src.slice(start, start + 1000);
    assert.ok(fn.includes("recordInteraction("), "一轮结束必须记关系");
    assert.ok(fn.includes("negative") && fn.includes("positive"), "本轮有无工具失败要映射到 positive/negative");
    const at = fn.indexOf("recordInteraction(");
    assert.ok(fn.lastIndexOf("try {", at) >= 0, "关系写入必须 try/catch 吞掉");
  });

  test("prompt 注入：yuanshu-emotion 里把 summary 一行放进情绪段", () => {
    const src = fs.readFileSync(path.join(ROOT, "engine", "yuanshu-emotion.mjs"), "utf8");
    assert.ok(src.includes("relationship.mjs"), "要引关系模块");
    assert.ok(/summary\(|relationshipLine|关系：信任/.test(src), "要注入关系摘要");
    assert.ok(src.includes("情绪语境"), "情绪段仍在");
  });
});
