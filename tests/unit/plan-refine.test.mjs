// 计划细化：失败样本 / 调用点 / 最小复现（2026-10-26）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gatherFailureSamples, findCallSites, minimalRepro, buildRefinement, applyRefinementToPlanFile, renderRefinement, searchTerms } from "../../engine/plan-refine.mjs";

function wsWith({ ledger = [], logs = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "refine-ws-"));
  fs.mkdirSync(path.join(root, "记忆", "运行时"), { recursive: true });
  fs.writeFileSync(path.join(root, "记忆", "运行时", "待汇报.json"), JSON.stringify({ items: ledger }), "utf8");
  if (Object.keys(logs).length) {
    fs.mkdirSync(path.join(root, "bg-jobs"), { recursive: true });
    for (const [name, text] of Object.entries(logs)) fs.writeFileSync(path.join(root, "bg-jobs", name), text, "utf8");
  }
  return root;
}

function repoWith(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "refine-repo-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text, "utf8");
  }
  return root;
}

const PLAN = {
  id: "p1", area: "render",
  title: "[渲染/视频] 作业「小语宣传片 45s 重渲染」反复失败 5 次",
  symptom: "作业「小语宣传片 45s 重渲染」反复失败 5 次",
  files: ["server.mjs", "engine/detached-run.mjs"],
  focusHook: "脱链渲染作业的失败回报 / 重试（enqueueReport / collectJobs）",
};

test("检索词能抽出引号里的作业名", () => {
  const terms = searchTerms(PLAN);
  assert.ok(terms.some((t) => t.includes("小语宣传片")), JSON.stringify(terms));
});

test("失败样本：从作业台账里按作业名匹配，且只要 failed/stalled", () => {
  const ws = wsWith({
    ledger: [
      { label: "小语宣传片 45s 重渲染", state: "failed", step: "ffmpeg exit 1", at: Date.now() },
      { label: "小语宣传片 45s 重渲染", state: "done", step: "ok" },
      { label: "别的作业", state: "failed", step: "x" },
    ],
  });
  const s = gatherFailureSamples(ws, PLAN);
  assert.equal(s.length, 1);
  assert.equal(s[0].source, "job-ledger");
  assert.match(s[0].text, /ffmpeg exit 1/);
});

test("失败样本：台账没有时，从后台日志里捞错误行", () => {
  const ws = wsWith({ logs: { "小语宣传片-45s.log": "step 1\nError: ENOENT inside\nlast line\nexit code 1\n" } });
  const s = gatherFailureSamples(ws, PLAN);
  assert.ok(s.some((x) => x.source.startsWith("bg-jobs/") && /ENOENT|exit code/.test(x.text)));
});

test("调用点：只在允许改动的文件里找，给出 file:line 与上下文", () => {
  const repo = repoWith({
    "server.mjs": "import x\nconst a = 1\nenqueueReport(job)\nconst b = 2\n",
    "engine/detached-run.mjs": "export function launchDetached() {}\n",
    "engine/other.mjs": "enqueueReport(job)\n",
  });
  const sites = findCallSites(repo, { ...PLAN, files: ["server.mjs", "engine/detached-run.mjs"] });
  assert.ok(sites.length >= 1);
  assert.equal(sites[0].path, "server.mjs");
  assert.equal(sites[0].line, 3);
  assert.ok(!sites.some((s) => s.path === "engine/other.mjs"), "不允许改的文件里不该出现");
  assert.match(sites[0].excerpt, /3: enqueueReport/);
});

test("最小复现按领域给，且步骤不是空话", () => {
  const r = minimalRepro(PLAN, { samples: [{ text: "ffmpeg exit 1" }] });
  assert.equal(r.area, "render");
  assert.ok(r.steps.length >= 3);
  assert.match(r.steps.join(" "), /job_status|failed/);
});

test("细化完整度：样本与调用点都有才算 complete", () => {
  const ws = wsWith({ ledger: [{ label: "小语宣传片 45s 重渲染", state: "failed", step: "boom" }] });
  const repo = repoWith({ "server.mjs": "enqueueReport(job)\n", "engine/detached-run.mjs": "x\n" });
  const ref = buildRefinement({ wsRoot: ws, repoRoot: repo, proposal: PLAN });
  assert.equal(ref.complete, true, JSON.stringify({ s: ref.samples.length, c: ref.sites.length }));
  const md = renderRefinement(ref);
  assert.match(md, /## 细化/);
  assert.match(md, /### 失败样本/);
  assert.match(md, /### 调用点/);
  assert.match(md, /### 最小复现/);
});

test("applyRefinementToPlanFile 幂等：重复写只保留一块", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-"));
  const planPath = path.join(dir, "PLAN.md");
  fs.writeFileSync(planPath, "# 标题\n\n## 动哪\n- a\n", "utf8");
  const ref = { samples: [], sites: [], repro: { steps: ["1) 复现"] }, complete: false };
  applyRefinementToPlanFile(planPath, ref);
  applyRefinementToPlanFile(planPath, ref);
  const text = fs.readFileSync(planPath, "utf8");
  assert.equal(text.split("## 细化").length - 1, 1);
  assert.match(text, /# 标题/);
});
