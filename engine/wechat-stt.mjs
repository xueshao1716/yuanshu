// ===== wechat-stt.mjs —— 语音转文字（2026-10-28）=====
//
// 为什么不再信腾讯的 voice_item.text：
//   Hermes 的注释里写得很清楚——非中文语音时腾讯转写是垃圾（俄语会回成英语音素）。
//   所以我们下载原始音频，自己转写。
//
// 后端：faster-whisper（CPU 可跑，模型首次自动下载）。
// 模型选择：默认 small（约 460MB，中文可用）；可改 <ws>/记忆/运行时/语音转写.json {"model":"base"}。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
// 2026-10-28：服务和语音合成共用同一个 python 解析（SYSTEM 的 PATH 里通常没有 python）
import { resolvePython } from "./wechat-voice.mjs";

// 2026-10-28：依赖装在项目内 engine/py/vendor（服务以 SYSTEM 跑，读不到用户目录的 site-packages）
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VENDOR_DIR = path.join(HERE, "py", "vendor");

/**
 * 找 faster-whisper 模型的本地快照目录（避免每次连 Hub；SYSTEM 下连不上）。
 * 依次看：显式 env、D:\huggingface\cache、用户 .cache。
 */
export function resolveModelDir(model = "base") {
  const roots = [
    process.env.WHISPER_CACHE,
    process.env.HF_HOME ? path.join(process.env.HF_HOME, "hub") : "",
    "D:\\huggingface\\cache\\hub",
    path.join(process.env.USERPROFILE || "C:\\Users\\Public", ".cache", "huggingface", "hub"),
  ].filter(Boolean);
  const repo = `models--Systran--faster-whisper-${model}`;
  for (const root of roots) {
    const dir = path.join(root, repo, "snapshots");
    try {
      const snaps = fs.readdirSync(dir).filter(Boolean);
      if (!snaps.length) continue;
      const full = path.join(dir, snaps[0]);
      if (fs.existsSync(path.join(full, "model.bin"))) return full;
    } catch {}
  }
  return "";
}

export const STT_REL = path.join("记忆", "运行时", "语音转写.json");
const PY_SCRIPT = String.raw`
import sys, json, os
try:
    from faster_whisper import WhisperModel
except Exception as e:
    print(json.dumps({"ok": False, "error": "faster_whisper 未安装: %s" % e})); sys.exit(0)
audio = sys.argv[1]
model_name = sys.argv[2] if len(sys.argv) > 2 else "small"
try:
    # 2026-10-28：给的是本地目录就用本地（服务以 SYSTEM 跑，连 Hub 会超时）
    local_only = os.path.isdir(model_name)
    model = WhisperModel(model_name, device="cpu", compute_type="int8", local_files_only=local_only)
    segments, info = model.transcribe(audio, beam_size=1, vad_filter=True)
    text = "".join(s.text for s in segments).strip()
    print(json.dumps({"ok": True, "text": text, "lang": getattr(info, "language", ""), "prob": round(float(getattr(info, "language_probability", 0) or 0), 3)}, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)[:300]}, ensure_ascii=False))
`;

export function sttConfig(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(String(wsRoot || "."), STT_REL), "utf8"));
    if (raw && typeof raw.model === "string") return { model: raw.model.slice(0, 30), enabled: raw.enabled !== false };
  } catch {}
  return { model: "small", enabled: true };
}

/**
 * 转写一个音频文件。
 * @returns {Promise<{ok:boolean, text?:string, lang?:string, error?:string}>}
 */
export function transcribe({ file, wsRoot = ".", model, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    if (!file || !fs.existsSync(file)) return resolve({ ok: false, error: "音频文件不存在" });
    const cfg = sttConfig(wsRoot);
    if (!cfg.enabled) return resolve({ ok: false, error: "转写已关闭" });
    const m = model || cfg.model;
    let out = "", err = "";
    let child;
    try {
      const env = { ...process.env };
      // 让子进程优先用项目内 vendor（否则 SYSTEM 下 "No module named faster_whisper"）
      env.PYTHONPATH = fs.existsSync(VENDOR_DIR) ? [VENDOR_DIR, env.PYTHONPATH || ""].filter(Boolean).join(path.delimiter) : env.PYTHONPATH;
      env.PYTHONIOENCODING = "utf-8";
      const py = resolvePython();
      // 本地有快照就直接给它目录；没有才用模型名（会尝试下载）
      const localDir = resolveModelDir(m);
      const modelArg = localDir || m;
      if (localDir) {
        env.HF_HOME = path.dirname(path.dirname(path.dirname(path.dirname(localDir)))); // .../hub → 缓存根
        env.HF_HUB_OFFLINE = "1";
      } else {
        env.HF_ENDPOINT = env.HF_ENDPOINT || "https://hf-mirror.com";
      }
      child = spawn(py, ["-c", PY_SCRIPT, file, modelArg], { windowsHide: true, env });
    } catch (e) {
      return resolve({ ok: false, error: String(e?.message || e).slice(0, 120) });
    }
    const timer = setTimeout(() => { try { child.kill() } catch {} resolve({ ok: false, error: "转写超时" }) }, timeoutMs);
    child.stdout.on("data", (d) => { out += d.toString("utf8") });
    child.stderr.on("data", (d) => { err += d.toString("utf8") });
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e?.message || e).slice(0, 120) }) });
    child.on("close", () => {
      clearTimeout(timer);
      const line = out.trim().split(/\r?\n/).pop() || "";
      try {
        const j = JSON.parse(line);
        if (j.ok && j.text) return resolve({ ok: true, text: String(j.text).slice(0, 2000), lang: j.lang, prob: j.prob });
        return resolve({ ok: false, error: j.error || "没转出文字" });
      } catch {
        return resolve({ ok: false, error: ((err || out || "转写失败") + ` | python=${resolvePython()} PYTHONPATH=${env.PYTHONPATH || ""}`).slice(0, 400) });
      }
    });
  });
}

/** 首次写一份配置（已存在不覆盖）。 */
export function seedSttConfig(wsRoot) {
  const file = path.join(String(wsRoot || "."), STT_REL);
  try {
    if (fs.existsSync(file)) return { ok: true, existed: true };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ model: "small", enabled: true, note: "model 可选 tiny/base/small/medium；enabled=false 关闭转写" }, null, 2), "utf8");
    return { ok: true, existed: false };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) } }
}
