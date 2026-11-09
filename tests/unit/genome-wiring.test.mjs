// 接线静态断言（2026-11-09）：基因网络必须真的接在轮末、关系/失败计数、prompt 一行上，
// 而不是只写了一个孤立模块。同时验证 genome_status 工具可执行、只读。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
// 静态断言只看代码，不看注释：注释里可以写"没有 setInterval / 不写 记忆/harness"
const codeOnly = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "genome-wire-"));

describe("模块边界", () => {
  test("engine/genome.mjs 只落 记忆/运行时/基因.json，且不碰人格定义 / harness", () => {
    const src = read("engine/genome.mjs");
    const code = codeOnly(src);
    assert.ok(code.includes('"基因.json"'), "落盘文件必须是 基因.json");
    assert.ok(code.includes('"运行时"'), "落盘目录必须是 记忆/运行时");
    assert.equal(/persona-def/.test(code), false, "不得 import 人格定义模块");
    assert.equal(/记忆[\\/]harness/.test(code), false, "不得写记忆/harness");
    assert.equal(/\bsetInterval\b|\bsetTimeout\b/.test(code), false, "基因层不得自带定时器");
  });

  test("信号来自 relationship（intimacy/trust），不是写死常量", () => {
    const src = read("engine/genome.mjs");
    assert.ok(src.includes('from "./relationship.mjs"'), "必须 import relationship");
    assert.ok(src.includes("relationshipCurrent()"), "必须实际取关系快照");
    assert.ok(src.includes("rel?.intimacy") && src.includes("rel?.trust"), "intimacy/trust 必须来自关系层");
  });

  test("advanceTurn 是唯一轮末入口，且没有定时器", () => {
    const code = codeOnly(read("engine/genome.mjs"));
    assert.ok(/export function advanceTurn\(/.test(code));
    assert.ok(code.includes("pendingGuardBlocks"), "红线拦截要能计入 stress");
    assert.equal((code.match(/setInterval|setTimeout/g) || []).length, 0);
  });
});

describe("轮末接线", () => {
  test("unified-chat 收轮调 advanceGenomeTurn({toolFailures})，且一轮只推进一次", () => {
    const src = read("engine/unified-chat.mjs");
    assert.ok(src.includes('import { advanceTurn as advanceGenomeTurn } from "./genome.mjs"'));
    assert.ok(src.includes("advanceGenomeTurn({ toolFailures: turnToolFailures })"));
    assert.ok(src.includes("genomeAdvanced"), "必须有只推进一次的防重入标记");
    assert.ok(/try\s*\{[\s\S]{0,220}advanceGenomeTurn/.test(src), "调用必须包在 try/catch 里");
  });

  test("emotion.init 初始化基因层；红线 sink 把拦截转给 genome", () => {
    const src = read("engine/emotion.mjs");
    assert.ok(src.includes('import { init as initGenome, recordGuardBlock } from "./genome.mjs"'));
    assert.ok(src.includes("initGenome(wsRoot)"));
    assert.ok(/setGuardBlockSink\([\s\S]{0,400}recordGuardBlock\(\)/.test(src), "guard sink 必须记一次基因压力");
  });
});

describe("prompt 注入一行", () => {
  test("yuanshu-emotion 把基因摘要拼在情绪段，且只取一行", () => {
    const src = read("engine/yuanshu-emotion.mjs");
    assert.ok(src.includes("genomePromptLine"));
    assert.ok(src.includes("replace(/\\s*\\n\\s*/g"));
    assert.ok(src.includes("relationshipLine(), genomeLine()"));
    assert.ok(src.includes("基因：|基因告警："), "去重判断要认得基因行");
  });

  test("端到端：正常状态注入且只出现一次；超阈值时变成告警", async () => {
    const emotion = await import("../../engine/emotion.mjs");
    const { beginYuanshuEmotion } = await import("../../engine/yuanshu-emotion.mjs");
    const genome = await import("../../engine/genome.mjs");

    const root1 = tmpRoot();
    emotion.init(root1);
    genome.init(root1);
    const h1 = beginYuanshuEmotion("wire-ok", "你好", []);
    const text1 = h1.filter((m) => m.role === "system").map((m) => String(m.content || "")).join("\n");
    assert.match(text1, /基因：core_identity 漂移 0\.00\/0\.15（正常）/);
    assert.equal((text1.match(/基因：/g) || []).length, 1, "prompt 里只能有一行基因摘要");

    const root2 = tmpRoot();
    fs.mkdirSync(path.join(root2, "记忆", "运行时"), { recursive: true });
    fs.writeFileSync(path.join(root2, "记忆", "运行时", "基因.json"), JSON.stringify({
      generation: 0,
      baseline: Object.fromEntries(genome.GENES.map((g) => [g, 0.5])),
      genes: Object.fromEntries(genome.GENES.map((g) => [g, 0.5])),
      signals: { intimacy: 0.5, novelty: 0.5, stress: 0.1, trust: 0.5 },
      updatedAt: new Date().toISOString(),
    }), "utf8");
    // 只抬高忠诚：核心认同簇 0.5/3 = 0.1667 > 0.15
    const seeded = JSON.parse(fs.readFileSync(path.join(root2, "记忆", "运行时", "基因.json"), "utf8"));
    seeded.genes.loyalty = 1;
    fs.writeFileSync(path.join(root2, "记忆", "运行时", "基因.json"), JSON.stringify(seeded), "utf8");
    emotion.init(root2);
    genome.init(root2);
    const h2 = beginYuanshuEmotion("wire-over", "你好", []);
    const text2 = h2.filter((m) => m.role === "system").map((m) => String(m.content || "")).join("\n");
    assert.match(text2, /基因告警：核心认同簇（core_identity）偏离 0\.17\/0\.15/);
    assert.match(text2, /建议复看最近经历/);
  });
});

describe("genome_status 工具", () => {
  test("工具表里有 schema，执行器有分支且只读", async () => {
    const src = read("engine/tools/unified-tools.mjs");
    assert.ok(src.includes('name: "genome_status"'));
    assert.ok(src.includes('if (name === "genome_status")'));
    assert.ok(src.includes("statusText({ emotions })"));
    assert.ok(src.includes("getTide(200)"), "体检项要读情绪潮汐的 primary 分布");
    const { BASE_TOOL_SCHEMAS } = await import("../../engine/tools/unified-tools.mjs");
    const schema = BASE_TOOL_SCHEMAS.find((t) => t.function?.name === "genome_status");
    assert.ok(schema, "genome_status 必须出现在模型可见工具表里");
    assert.equal(schema.function.parameters.type, "object");
  });

  test("执行 genome_status 返回 10 基因 / 4 信号 / 4 簇，不写文件", async () => {
    const { createUnifiedToolExecutor } = await import("../../engine/tools/unified-tools.mjs");
    const genome = await import("../../engine/genome.mjs");
    const root = tmpRoot();
    genome.init(root);
    const execute = createUnifiedToolExecutor({});
    const out = await execute("genome_status", {}, {});
    assert.notEqual(out.isError, true);
    const parsed = JSON.parse(out.text);
    assert.equal(Object.keys(parsed["基因"]).length, 10);
    assert.equal(Object.keys(parsed["信号"]).length, 4);
    assert.equal(Object.keys(parsed["簇"]).length, 4);
    assert.equal(parsed["世代"], 0);
    assert.equal(fs.existsSync(path.join(root, "记忆", "运行时", "基因.json")), false, "只读工具不得顺手落盘");
  });
});
