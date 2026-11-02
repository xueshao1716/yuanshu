// ===== self-change-validate.mjs —— 改完先自证（方案 B：测试 + 交付门）2026-11-02 =====
//
// 顺序固定：边界校验 → 跑测试 → 判交付门。三道都过才算通过，才允许进面板。
// 依赖注入（runTests / runGate），便于单测；默认实现走真实命令。
import { execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { checkChange, POLICY } from "./self-change.mjs";

const exec = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 180000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
    resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
  });
});

/** 把改动文件映射到对应测试文件：engine/foo.mjs → tests/unit/foo.test.mjs */
export function relatedTests(files = []) {
  const out = [];
  for (const f of files) {
    if (!f || f.startsWith("tests/")) { if (f) out.push(f); continue }
    const base = String(f).split("/").pop().replace(/\.(mjs|js|ts|tsx)$/, "");
    const cand = `tests/unit/${base}.test.mjs`;
    if (fs.existsSync(path.join(process.cwd(), cand))) out.push(cand);
  }
  return [...new Set(out)];
}

/** 默认测试跑法：只跑相关测试（找不到就明确失败，不跑全量）。 */
export function defaultRunTests({ wsRoot, files = [] } = {}) {
  const targets = relatedTests(files);
  if (!targets.length) {
    return Promise.resolve({ ok: false, code: 1, detail: "没有找到与改动对应的测试文件（请新增或指定 tests/ 下的测试）" });
  }
  const args = targets;
  return exec(process.execPath, ["--test", ...args], { cwd: wsRoot }).then((r) => ({
    ok: r.ok,
    code: r.code,
    detail: (r.stdout + r.stderr).slice(-600),
  }));
}

/**
 * 校验一个候选改动。
 * @returns {{ok:boolean, stage:'policy'|'tests'|'gate'|'green', errors?:string[], tests?:any, gate?:any}}
 */
export async function validateCandidate({ files = [], runTests, runGate } = {}) {
  const chk = checkChange({ files });
  if (!chk.ok) return { ok: false, stage: "policy", errors: chk.errors };

  if (typeof runTests !== "function") return { ok: false, stage: "tests", errors: ["没有测试跑法"] };
  let t;
  try { t = await runTests() } catch (e) { t = { ok: false, detail: String(e?.message || e).slice(0, 200) } }
  if (!t?.ok) return { ok: false, stage: "tests", errors: ["测试没过"], tests: t };

  if (typeof runGate !== "function") return { ok: false, stage: "gate", errors: ["没有交付门"] };
  let g;
  try { g = await runGate() } catch (e) { g = { verdict: "RED", error: String(e?.message || e).slice(0, 200) } }
  const verdict = String(g?.verdict || "").toUpperCase();
  if (verdict !== POLICY.requireVerdict) return { ok: false, stage: "gate", errors: [`交付门是 ${verdict || "未知"}`], gate: g };

  return { ok: true, stage: "green", tests: t, gate: g };
}

/** 真实跑法：测试 + 交付门（交付门由调用方注入，避免循环依赖）。 */
export async function validateReal({ wsRoot, files = [], runGate } = {}) {
  return validateCandidate({
    files,
    runTests: () => defaultRunTests({ wsRoot, files }),
    runGate,
  });
}

export { POLICY, checkChange, path };
