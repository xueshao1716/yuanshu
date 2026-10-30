// 串行跑单元测试：逐个文件跑，避免并行时图像/原生库抢资源导致"假红"（2026-10-30）
//
// 为什么要有：并行跑全量时 artifact-localize / image-dimensions / image-routing 会红，
// 单独跑全绿（9/4/16 通过）。全量结果不可信，等于每次都要人肉判断——那就不是门禁。
//
// 用法：
//   node scripts/test-unit.mjs            # 全部
//   node scripts/test-unit.mjs --filter knowledge
//   node scripts/test-unit.mjs --quiet
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const dir = path.join(root, "tests", "unit");

const argv = process.argv.slice(2);
const filter = (() => { const i = argv.indexOf("--filter"); return i >= 0 ? String(argv[i + 1] || "") : "" })();
const quiet = argv.includes("--quiet");

const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.mjs"))
  .filter((f) => !filter || f.includes(filter))
  .sort();

if (!files.length) { console.log("没有匹配的测试文件"); process.exit(1) }

const runOne = (file) => new Promise((resolve) => {
  const child = spawn(process.execPath, ["--test", path.join("tests", "unit", file)], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (b) => { out += String(b) });
  child.stderr.on("data", (b) => { out += String(b) });
  child.on("close", (code) => {
    const num = (re) => { const m = out.match(re); return m ? Number(m[1]) : null };
    resolve({
      file,
      code,
      pass: num(/^ℹ pass (\d+)$/m) ?? 0,
      fail: num(/^ℹ fail (\d+)$/m) ?? 0,
      output: out,
    });
  });
});

// 2026-10-30：这几个会开原生库/子进程，别的测试同时在跑时容易假红 → 独占跑
const HEAVY = new Set(["artifact-localize.test.mjs", "image-dimensions.test.mjs", "image-routing.test.mjs"]);
const started = Date.now();
const results = [];
const log = (r) => {
  if (quiet) return;
  const mark = r.code === 0 ? "✔" : "✘";
  console.log(`${mark} ${r.file.padEnd(44)} ${r.pass} 通过${r.fail ? ` / ${r.fail} 失败` : ""}${r.code !== 0 && r.fail === 0 ? "（进程异常退出，无断言失败）" : ""}`);
};

const light = files.filter((f) => !HEAVY.has(f));
const heavy = files.filter((f) => HEAVY.has(f));

// 并发 3 跑轻的（每个文件独立进程，互不污染）
const CONCURRENCY = Number((argv.find((a) => a.startsWith("--concurrency=")) || "").split("=")[1]) || 3;
let cursor = 0;
const worker = async () => {
  while (cursor < light.length) {
    const f = light[cursor++];
    const r = await runOne(f);
    results.push(r);
    log(r);
  }
};
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, light.length || 1) }, worker));

// 重的独占
for (const f of heavy) {
  const r = await runOne(f);
  results.push(r);
  log(r);
}

results.sort((a, b) => a.file.localeCompare(b.file));

// 落一份结果，方便后台跑完后直接读
try {
  fs.writeFileSync(path.join(root, "tests", ".last-run.json"), JSON.stringify({
    at: Date.now(),
    files: results.length,
    results: results.map((r) => ({ file: r.file, code: r.code, pass: r.pass, fail: r.fail })),
  }, null, 2), "utf8");
} catch {}

const totalPass = results.reduce((a, r) => a + r.pass, 0);
const totalFail = results.reduce((a, r) => a + r.fail, 0);
const bad = results.filter((r) => r.code !== 0);
const seconds = Math.round((Date.now() - started) / 1000);

console.log("");
console.log(`文件 ${results.length} 个 · 断言 ${totalPass + totalFail} 条 · 通过 ${totalPass} · 失败 ${totalFail} · 用时 ${seconds}s`);

if (bad.length) {
  console.log(`\n不过的文件（${bad.length}）：`);
  for (const r of bad) {
    console.log(`  ${r.file}（exit ${r.code}，断言失败 ${r.fail}）`);
    const lines = String(r.output).split(/\r?\n/);
    const failed = lines.filter((l) => /^✖ /.test(l) || /AssertionError/.test(l)).slice(0, 4);
    for (const l of failed) console.log(`    ${l.trim().slice(0, 160)}`);
  }
  process.exitCode = 1;
}
