// promises.mjs 测试：承诺提取 / 记账 / 结清
// 两条硬规矩必须有测试守着：
//   ① 绝不自动标记"已兑现"（没有任何自动结清路径）
//   ② 宁可漏，不可灌水（没有一人称主语的建议不能进账）
// 运行：node --test tests/unit/promises.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractPromises, recordPromises, loadPromises, closePromise,
  pendingPromises, pendingPromiseText, promiseAge, promisePaths,
} from "../../engine/promises.mjs";

const cleanups = [];
function ws() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-prom-")); cleanups.push(d); return d; }
const AT = new Date(2026, 8, 14, 10, 0, 0);

describe("承诺提取：认什么", () => {
  test("认出「我 + 时间词 + 动作」", () => {
    const r = extractPromises("好的，我明天给你补个测试。", { at: AT, sessionId: "s1" });
    assert.equal(r.length, 1);
    assert.match(r[0].text, /^明天/);
    assert.match(r[0].text, /补个测试/);
    assert.equal(r[0].status, "pending");
    assert.ok(r[0].due, "「明天」应给出到期时间");
  });

  test("认出「时间词 + 我 + 动作」", () => {
    const r = extractPromises("这个先放着。回头我再看看这个问题。", { at: AT });
    assert.equal(r.length, 1);
    assert.match(r[0].text, /回头/);
    assert.match(r[0].text, /再看看这个问题/);
    assert.equal(r[0].due, null, "「回头」没有具体到期日");
  });

  test("「后天」给出两天后的到期", () => {
    const r = extractPromises("我后天把文档发你。", { at: AT });
    assert.equal(r.length, 1);
    assert.equal(new Date(r[0].due).getTime() - AT.getTime(), 2 * 86400_000);
  });
});

describe("承诺提取：不认什么（宁漏不灌水）", () => {
  test("否定句是决定不是承诺", () => {
    assert.equal(extractPromises("我明天不做这个了。", { at: AT }).length, 0);
  });

  test("条件句不是承诺", () => {
    assert.equal(extractPromises("如果这版不行，我下次再改一版给你。", { at: AT }).length, 0);
  });

  test("没有一人称主语的建议不进账", () => {
    const r = extractPromises("这个先不动。下次再重新检查一遍配置比较好。", { at: AT });
    assert.equal(r.length, 0, "给用户的建议不能被记成助手的承诺");
  });

  test("「下次再说」这类敷衍不算承诺", () => {
    assert.equal(extractPromises("下次再说。", { at: AT }).length, 0);
  });

  test("空回复不产生任何东西", () => {
    assert.deepEqual(extractPromises("", { at: AT }), []);
    assert.deepEqual(extractPromises(null, { at: AT }), []);
  });

  test("同一轮里同一件事只留一条", () => {
    const r = extractPromises("我明天给你补个测试，我明天给你补个测试。", { at: AT });
    assert.equal(r.length, 1);
  });
});

describe("承诺记账", () => {
  test("收录后能读回，同要点不重复入库", () => {
    const w = ws();
    const first = recordPromises(w, extractPromises("我明天给你补个测试。", { at: AT }));
    assert.equal(first.added, 1);
    const again = recordPromises(w, extractPromises("我明天给你补个测试。", { at: new Date(AT.getTime() + 3600_000) }));
    assert.equal(again.added, 0, "同要点已在账上就不该重复记");
    const list = loadPromises(w);
    assert.equal(list.length, 1);
    assert.equal(list[0].status, "pending");
  });

  test("落盘是原子写且位置在 记忆/ 下", () => {
    const w = ws();
    recordPromises(w, extractPromises("我明天给你补个测试。", { at: AT }));
    assert.ok(fs.existsSync(promisePaths(w).file));
    assert.match(promisePaths(w).file, /记忆/);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(promisePaths(w).file, "utf8")));
  });

  test("文件损坏时返回空账而不是抛错", () => {
    const w = ws();
    fs.mkdirSync(path.join(w, "记忆"), { recursive: true });
    fs.writeFileSync(promisePaths(w).file, "{不是数组");
    assert.deepEqual(loadPromises(w), []);
  });

  test("超额时绝不丢弃还挂着的 pending", () => {
    const w = ws();
    const many = [];
    for (let i = 0; i < 210; i++) many.push({ id: `p${i}`, at: AT.toISOString(), sessionId: "", text: `明天给你办第${i}件事`, due: null, status: "pending", evidence: null, closedAt: null });
    recordPromises(w, many);
    const pending = loadPromises(w).filter((p) => p.status === "pending");
    assert.equal(pending.length, 210, "上限只该淘汰已结清的旧账");
  });
});

describe("承诺结清：只能显式", () => {
  test("结清需要显式调用并写明证据", () => {
    const w = ws();
    recordPromises(w, extractPromises("我明天给你补个测试。", { at: AT }));
    const id = loadPromises(w)[0].id;
    assert.equal(pendingPromises(w, { now: AT }).length, 1);
    const r = closePromise(w, id, { status: "kept", evidence: "tests/unit/promises.test.mjs 已加" , now: AT });
    assert.equal(r.ok, true);
    assert.equal(pendingPromises(w, { now: AT }).length, 0, "结清后不再挂账");
    const closed = loadPromises(w).find((p) => p.id === id);
    assert.equal(closed.status, "kept");
    assert.match(closed.evidence, /promises\.test\.mjs/);
    assert.ok(closed.closedAt);
  });

  test("可以作废但不接受任意状态", () => {
    const w = ws();
    recordPromises(w, extractPromises("我明天给你补个测试。", { at: AT }));
    const id = loadPromises(w)[0].id;
    assert.equal(closePromise(w, id, { status: "done" }).ok, false, "只允许 kept / dropped");
    assert.equal(closePromise(w, "p_不存在", { status: "kept" }).ok, false);
    assert.equal(pendingPromises(w, { now: AT }).length, 1, "非法调用不应改动账本");
  });

  test("写盘失败不能假报已结清", () => {
    const w = ws();
    recordPromises(w, extractPromises("我明天给你补个测试。", { at: AT }));
    const id = loadPromises(w)[0].id;
    const failingFs = {
      existsSync: fs.existsSync.bind(fs),
      readFileSync: fs.readFileSync.bind(fs),
      mkdirSync: fs.mkdirSync.bind(fs),
      writeFileSync() { throw new Error("磁盘满"); },
      renameSync: fs.renameSync.bind(fs),
      unlinkSync: fs.unlinkSync.bind(fs),
    };
    const r = closePromise(w, id, { status: "dropped" }, failingFs);
    assert.equal(r.ok, false);
    assert.equal(pendingPromises(w, { now: AT }).length, 1);
  });

  test("模块内不存在自动结清路径（回归锁）", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "engine", "promises.mjs"), "utf8");
    // closePromise 只被显式调用；模块内没有定时器/自动判定
    assert.ok(!/setInterval|setTimeout/.test(src), "承诺结清不能被定时器驱动");
    assert.ok(!/status\s*=\s*["']kept["']/.test(src.replace(/function closePromise[\s\S]*?\n}/, "")),
      "除 closePromise 外不得有地方自动置为已兑现");
  });
});

describe("逾期与提示词", () => {
  test("有明确到期日的过期判为逾期", () => {
    const p = { at: AT.toISOString(), due: new Date(AT.getTime() + 86400_000).toISOString() };
    const late = promiseAge(p, new Date(AT.getTime() + 4 * 86400_000));
    assert.equal(late.overdue, true);
    assert.match(late.phrase, /天前/);
    const fresh = promiseAge(p, new Date(AT.getTime() + 3600_000));
    assert.equal(fresh.overdue, false);
  });

  test("没有到期日的账挂满一周才算逾期", () => {
    const p = { at: AT.toISOString(), due: null };
    assert.equal(promiseAge(p, new Date(AT.getTime() + 3 * 86400_000)).overdue, false);
    assert.equal(promiseAge(p, new Date(AT.getTime() + 8 * 86400_000)).overdue, true);
  });

  test("空账不占上下文", () => {
    assert.equal(pendingPromiseText(ws(), { now: AT }), "");
  });

  test("有账时陈述事实并要求交代，且不许把打算说成已完成", () => {
    const w = ws();
    recordPromises(w, extractPromises("我明天给你补个测试。", { at: AT }));
    const text = pendingPromiseText(w, { now: new Date(AT.getTime() + 3 * 86400_000) });
    assert.match(text, /待兑现承诺/);
    assert.match(text, /补个测试/);
    assert.match(text, /已逾期/);
    assert.ok(!/已完成|已经完成/.test(text), "提示词不得替模型宣称已完成");
    assert.match(text, /没做就说没做/);
  });

  test("逾期排在前面", () => {
    const w = ws();
    const now = new Date(AT.getTime() + 10 * 86400_000);
    recordPromises(w, [
      { id: "p_new", at: now.toISOString(), text: "明天给你办新的", due: null, status: "pending" },
      { id: "p_old", at: AT.toISOString(), text: "明天给你办旧的", due: null, status: "pending" },
    ]);
    const list = pendingPromises(w, { now });
    assert.equal(list[0].id, "p_old", "越久未结清越该被先追问");
  });
});

test.after(() => {
  for (const d of cleanups) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

