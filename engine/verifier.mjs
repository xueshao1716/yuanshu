// engine/verifier.mjs —— 独立验证者（2026-09-18）
//
// 抄自 RSIAgent 的那条设计（也是它最值钱的一条）：**执行者不能自己宣布成功**。
// Verifier 看不到 Actor 的私有推理与记忆，只检查环境里可观察的产物/状态，返回
// PASS / FAIL / UNVERIFIED。三角色互相制衡的前提就是这个信息边界。
//
// 为什么元枢需要它：我今天两次翻车（"字全对"没看图就宣称验收通过；日志小节没写出来却以为成功）
// 都是同一个病——**自证**。纪律写在提示词里治不了它，只有结构能：验证轮拿到的输入里
// **根本没有执行者的自述**，只有一个待核对的声明 + 产物路径。
//
// 两条硬边界（都在这里可执行地检查）：
//   ① 验证者**不能改**被验证的东西：验证前后对产物取哈希，变了就直接判 FAIL（tampered）。
//      能改标的的"裁判"不算裁判。
//   ② 验证轮**不许**看执行者的过程：prompt 里只放声明与产物路径，不放 evidence 叙述——
//      这也是 Dream-RSI 的教训：把"高层结论"当先验喂进去，会把验证变成复述。
import crypto from "node:crypto";
import fs from "node:fs";
import { addNode } from "./trace.mjs";

export const VERDICTS = Object.freeze(["PASS", "FAIL", "UNVERIFIED"]);

/** 产物指纹：内容哈希（目录只取文件清单）。验证前后必须一致。 */
export function artifactDigest(paths = [], { fsMod = fs } = {}) {
  const out = {};
  for (const p of paths) {
    const file = String(p || "");
    if (!file) continue;
    try {
      const st = fsMod.statSync(file);
      if (st.isDirectory()) {
        const names = fsMod.readdirSync(file).sort().join(",");
        out[file] = `dir:${crypto.createHash("sha256").update(names).digest("hex").slice(0, 12)}`;
      } else {
        out[file] = `file:${crypto.createHash("sha256").update(fsMod.readFileSync(file)).digest("hex").slice(0, 12)}`;
      }
    } catch { out[file] = "missing"; }
  }
  return out;
}

/**
 * 验证轮提示词。**只给声明与产物路径**——这是信息边界，不是措辞问题。
 * 调用方不许把执行者的 evidence/推理拼进来（下面 buildVerifyPrompt 的入参就没有这个口子）。
 */
export function buildVerifyPrompt({ claim, artifacts = [] }) {
  const list = (artifacts || []).map((a) => `- ${a}`).join("\n") || "- （没有给出产物路径）";
  return `你是一名**独立验证者**。有人声称下面这件事已经完成——但你看不到他的推理、过程与自我说明，
只能自己动手查环境，然后给结论。

声明：${String(claim || "").trim()}

要核对的产物/位置：
${list}

规矩：
- **只读不写**：你可以 read / bash（只读命令），但**绝不许修改、创建或删除任何文件**。
  改了被验证的东西，验证就没有意义（系统会比对前后指纹，改了直接判 FAIL）。
- **不许**因为"声明听起来合理"就给 PASS；也不许因为"找不到证据"就给 FAIL——
  查不到关键事实时如实给 UNVERIFIED。
- 每个结论都要能落到具体命令与输出上。

结尾必须附一个 JSON 代码块（只能是 JSON，前后不要解释）：
\`\`\`json
{"verdict":"PASS|FAIL|UNVERIFIED","evidence":"你实际跑了什么、看到什么（≤200字）","checks":["命令1","命令2"]}
\`\`\``;
}

/** 取**最后**一个 json 块；verdict 不认识就返回 null（不猜）。 */
export function parseVerdict(text) {
  const blocks = [...String(text || "").matchAll(/```json\s*([\s\S]*?)```/g)];
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const d = JSON.parse(blocks[i][1]);
      const verdict = VERDICTS.includes(String(d?.verdict || "").toUpperCase()) ? String(d.verdict).toUpperCase() : null;
      if (!verdict) continue;
      return {
        verdict,
        evidence: String(d.evidence || "").trim().slice(0, 400),
        checks: (Array.isArray(d.checks) ? d.checks : []).map((c) => String(c).slice(0, 200)).slice(0, 20),
      };
    } catch { /* 试上一块 */ }
  }
  return null;
}

/**
 * **确定性**产物验证（不需要模型）：文件存在 / 体积合理 / 文件头对得上。
 *
 * 为什么要有它：模型验证轮适合判"做法对不对"，但"产物到底是不是一张真图/真视频"
 * 不需要模型——查字节就够，而且**比模型可靠**（模型看不到像素，这是我在真机上学到的：
 * 曾宣称"字全对"却被用户当场戳穿）。分镜出片这种长任务就该用这一层兜。
 *
 * 判据（都来自实测的坑）：0 字节 / 几百字节的错误页 → FAIL；扩展名与魔数不符 → FAIL；
 * 视频过小（<10KB）基本是截断流 → FAIL；文件缺失 → FAIL。
 */
export const MAGIC = Object.freeze({
  png: [0x89, 0x50, 0x4e, 0x47],
  jpg: [0xff, 0xd8, 0xff],
  gif: [0x47, 0x49, 0x46],
  webp: [0x52, 0x49, 0x46, 0x46],
  mp4: [0x00, 0x00, 0x00],          // ftyp 在偏移 4，下面单独看
  webm: [0x1a, 0x45, 0xdf, 0xa3],
  wav: [0x52, 0x49, 0x46, 0x46],
  mp3: [0x49, 0x44, 0x33],
});

export function verifyArtifactFiles(paths = [], { minBytes = 1024, videoMinBytes = 10 * 1024, fsMod = fs } = {}) {
  const checks = [];
  const failures = [];
  let verified = 0;
  for (const raw of paths) {
    const p = String(raw || "");
    if (!p) continue;
    // URL 不在这一层的职责里（要验就得真抓一次）：跳过并如实标注，不判成"文件不存在"——
    // 那是把"我没能力验"说成"东西是坏的"，两种错不是一回事。
    if (/^https?:\/\//i.test(p)) { checks.push(`跳过 ${p}（这层只验本地文件，URL 需另抓）`); continue }
    const ext = (p.split(".").pop() || "").toLowerCase();
    const isVideo = ["mp4", "webm", "mov", "mkv"].includes(ext);
    const floor = isVideo ? videoMinBytes : minBytes;
    let st = null;
    try { st = fsMod.statSync(p); } catch { failures.push(`${p}：文件不存在`); checks.push(`stat ${p} → ENOENT`); continue }
    if (st.isDirectory()) { failures.push(`${p}：是目录不是文件`); continue }
    if (st.size < floor) { failures.push(`${p}：只有 ${st.size} 字节（${isVideo ? "视频" : "文件"}至少要有 ${floor}）`); checks.push(`size ${p} = ${st.size}`); continue }
    let head = null;
    try { head = fsMod.readFileSync(p).subarray(0, 12) } catch { failures.push(`${p}：读不出内容`); continue }
    const looks = {
      png: MAGIC.png.every((b, i) => head[i] === b),
      jpg: MAGIC.jpg.every((b, i) => head[i] === b),
      gif: MAGIC.gif.every((b, i) => head[i] === b),
      webp: MAGIC.webp.every((b, i) => head[i] === b),
      webm: MAGIC.webm.every((b, i) => head[i] === b),
      mp4: head.subarray(4, 8).toString("ascii") === "ftyp",
      mov: head.subarray(4, 8).toString("ascii") === "ftyp",
      wav: MAGIC.wav.every((b, i) => head[i] === b),
      mp3: MAGIC.mp3.every((b, i) => head[i] === b),
    };
    if (looks[ext] === false) {
      failures.push(`${p}：扩展名 .${ext} 与文件头不符（可能是错误页或被改名）`);
      checks.push(`magic ${p} = ${[...head.subarray(0, 4)].map((b) => b.toString(16)).join(" ")}`);
      continue;
    }
    checks.push(`ok ${p}（${st.size} 字节${looks[ext] === true ? `，.${ext} 文件头对得上` : "，未知类型未校验头"}）`);
    verified++;
  }
  return {
    verdict: failures.length ? "FAIL" : verified > 0 ? "PASS" : "UNVERIFIED",
    evidence: failures.length ? failures.join("；") : checks.join("；") || "没有可验证的产物路径",
    checks,
    failures,
  };
}

/**
 * 跑一次独立验证。
 * `runTurn(prompt)` 由调用方注入（server 里是 unifiedChat）；wsRoot + traceId 给了就落一个验证节点。
 * 返回 { ok, verdict, evidence, checks, tampered, changed:[...] }。
 */
export async function verifyArtifacts({ wsRoot = "", traceId = "", attemptId = null, claim, artifacts = [], runTurn } = {}) {
  const startedAt = Date.now();
  const before = artifactDigest(artifacts);
  let raw = "";
  let parsed = null;
  try {
    raw = await runTurn(buildVerifyPrompt({ claim, artifacts }));
    parsed = parseVerdict(raw);
  } catch (e) {
    parsed = { verdict: "UNVERIFIED", evidence: `验证轮异常：${String(e?.message || e).slice(0, 140)}`, checks: [] };
  }
  if (!parsed) parsed = { verdict: "UNVERIFIED", evidence: "验证轮没有按契约给出结论（缺 JSON 块或 verdict 不合法）", checks: [] };
  const after = artifactDigest(artifacts);
  const changed = Object.keys(after).filter((k) => before[k] !== after[k]);
  const tampered = changed.length > 0;
  const verdict = tampered ? "FAIL" : parsed.verdict;
  const evidence = tampered ? `验证过程改动了被验证的产物（${changed.join("、")}）——裁判不许改标的` : parsed.evidence;
  if (wsRoot && traceId) {
    try {
      addNode(wsRoot, traceId, { parent: attemptId, action: "独立验证", input: String(claim || "").slice(0, 200), cost: (Date.now() - startedAt) / 1000, outcome: verdict, score: verdict === "PASS" ? 1 : 0 });
    } catch { /* 记录失败不影响结论 */ }
  }
  return { ok: verdict === "PASS", verdict, evidence, checks: parsed.checks, tampered, changed };
}
