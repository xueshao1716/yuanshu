// ===== wechat-voice.mjs —— 把文字变成微信语音条（SILK）2026-10-27 =====
//
// SILK 是微信语音用的编码（Skype 出的，微软维护），微信语音条 = 24kHz / 单声道 / 16bit / encode_type=6。
// 链路：系统中文语音(SAPI) → wav → ffmpeg 重采样 24k → pilk 编码 .silk → 作为 voice_item 发送。
//
// 为什么不用 edge-tts：2026-10-27 实测 `edge-tts` 直连微软接口返回 403（服务端开始拦），
// 而 Windows 自带的 SAPI 有中文音色（Microsoft Huihui Desktop），离线可用、不依赖网络。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const psQuote = (s) => String(s).replace(/'/g, "''");

/**
 * 找 python 解释器。
 * 2026-10-27 真机：服务以 SYSTEM 运行，PATH 里没有用户装的 python，
 * `python -c "import pilk"` 直接失败——所以要扫一遍常见位置。
 */
export function resolvePython({ exists = fs.existsSync } = {}) {
  const cands = [];
  try {
    const users = path.join(process.env.SystemDrive || "C:", "Users");
    for (const name of fs.readdirSync(users)) {
      const base = path.join(users, name, "AppData", "Local", "Programs", "Python");
      try {
        for (const ver of fs.readdirSync(base)) cands.push(path.join(base, ver, "python.exe"));
      } catch {}
    }
  } catch {}
  for (const root of [process.env.ProgramFiles || "C:\\Program Files", process.env.LOCALAPPDATA || ""]) {
    if (!root) continue;
    try {
      for (const name of fs.readdirSync(root)) if (/^Python3/i.test(name)) cands.push(path.join(root, name, "python.exe"));
    } catch {}
  }
  cands.push("C:\\Python312\\python.exe", "C:\\Python311\\python.exe", "python");
  for (const c of cands) { try { if (c === "python" || exists(c)) return c } catch {} }
  return "python";
}

/** 用系统语音合成 wav（默认 Huihui 中文音色）。 */
export function synthesizeWav({ text, outWav, voice = "Microsoft Huihui Desktop", rate = 0, run = execFileSync } = {}) {
  const file = outWav || path.join(os.tmpdir(), `yuanshu-voice-${Date.now()}.wav`);
  const ps = [
    "Add-Type -AssemblyName System.Speech;",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
    `try { $s.SelectVoice('${psQuote(voice)}') } catch {};`,
    `$s.Rate = ${Number(rate) || 0};`,
    `$s.SetOutputToWaveFile('${psQuote(file)}');`,
    `$s.Speak([Console]::In.ReadToEnd());`,
    "$s.Dispose();",
  ].join(" ");
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    input: String(text || ""), encoding: "utf8", timeout: 60000, windowsHide: true,
  });
  if (!fs.existsSync(file)) throw new Error("语音合成没生成 wav");
  return { ok: true, wav: file };
}

/** wav → 24k 单声道 16bit（微信要的格式）。 */
export function normalizeWav({ wav, outWav, run = execFileSync } = {}) {
  const out = outWav || wav.replace(/\.wav$/i, "-24k.wav");
  run("ffmpeg", ["-y", "-i", wav, "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", out], {
    encoding: "utf8", timeout: 60000, windowsHide: true, stdio: "pipe",
  });
  if (!fs.existsSync(out)) throw new Error("ffmpeg 重采样失败");
  return { ok: true, wav: out };
}

/** wav → silk（pilk，腾讯变体）。 */
export function encodeSilk({ wav, outSilk, run = execFileSync, python = resolvePython() } = {}) {
  const out = outSilk || wav.replace(/\.wav$/i, ".silk");
  const code = `import pilk,sys; pilk.encode(sys.argv[1], sys.argv[2], tencent=True)`;
  run(python, ["-c", code, wav, out], { encoding: "utf8", timeout: 120000, windowsHide: true, stdio: "pipe" });
  if (!fs.existsSync(out)) throw new Error("pilk 编码失败");
  return { ok: true, silk: out, bytes: fs.statSync(out).size };
}

/** wav 时长（毫秒）。 */
export function wavDurationMs(wav) {
  try {
    const buf = fs.readFileSync(wav);
    // 找 data chunk 之前读 fmt：采样率在偏移 24，位深 34，声道 22
    const rate = buf.readUInt32LE(24);
    const channels = buf.readUInt16LE(22);
    const bits = buf.readUInt16LE(34);
    const dataSize = buf.length - 44;
    const ms = Math.round((dataSize / (rate * channels * (bits / 8))) * 1000);
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  } catch { return 0 }
}

/**
 * 文字 → silk 文件（一步到位）。
 * @returns {{ok:true, silk:string, durationMs:number, bytes:number}}
 */
export function textToSilk({ text, outDir = os.tmpdir(), voice, rate = 0 } = {}) {
  const clean = String(text || "").trim();
  if (!clean) throw new Error("文本不能为空");
  const base = path.join(outDir, `yuanshu-voice-${Date.now()}`);
  const wav = `${base}.wav`;
  const wav24 = `${base}-24k.wav`;
  const silk = `${base}.silk`;
  synthesizeWav({ text: clean, outWav: wav, voice, rate });
  normalizeWav({ wav, outWav: wav24 });
  const durationMs = wavDurationMs(wav24);
  const enc = encodeSilk({ wav: wav24, outSilk: silk });
  try { fs.rmSync(wav, { force: true }); fs.rmSync(wav24, { force: true }) } catch {}
  return { ok: true, silk: enc.silk, bytes: enc.bytes, durationMs };
}
