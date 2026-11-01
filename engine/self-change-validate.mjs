// ===== self-change-validate.mjs —— 改完先自证（方案 B：测试 + 交付门）2026-11-02 =====
//
// 顺序固定：边界校验 → 跑测试 → 判交付门。三道都过才算通过，才允许进面板。
// 依赖注入（runTests / runGate），便于单测；默认实现走真实命令。
import { execFile } from "node:child_process";
import path from "node:path";
import { checkChange, POLICY } from "./self-change.mjs";

const exec = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 180000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
    resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
  });
});

/** 默认测试跑法：跑指定测试文件（或 tests/unit 下全部）。 */
export function defaultRunTests({ wsRoot, files = [] } = {}) {
  const targets = files.filter((f) => f.startsWith("tests/"));
  const args = targets.length ? targets : ["tests/unit"];
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
