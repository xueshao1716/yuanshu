// engine/asr-api.mjs —— 语音转文字（ASR）API（2026-08-22 Phase2 收尾）
// 链路：前端 MediaRecorder 录音 → base64 → POST /api/asr → 小米 token-plan 网关
//       mimo-v2.5-asr（免费通道，实测可用）→ 返回 { text }
// 注意：网关要求 input_audio 消息不能带 text 部分（prompt 由网关注入），否则 400。
import { json } from "./http-utils.mjs";

let _resolveAuth = null;
let _readJsonFile = null;
let _modelsPath = "";
let _httpJsonFetch = null;

export function initAsrApi({ resolveAuth, readJsonFile, modelsPath, httpJsonFetch }) {
  _resolveAuth = resolveAuth || _resolveAuth;
  _readJsonFile = readJsonFile || _readJsonFile;
  _modelsPath = modelsPath || _modelsPath;
  _httpJsonFetch = httpJsonFetch || _httpJsonFetch;
}

const PROVIDER = "xiaomi-token-plan-cn";
const MODEL = "mimo-v2.5-asr";
const DEFAULT_BASE = "https://token-plan-cn.xiaomimimo.com/v1";
// 上游网关（mimo-v2.5-asr）只接受 wav/mp3（webm 会被拒："must be one of: wav, mp3"）；
// 前端负责把 MediaRecorder 产物转成 WAV 再发
const ALLOWED_FORMATS = new Set(["wav", "mp3"]);
const MAX_AUDIO_MB = 12;

function resolveBase() {
  try {
    const store = _readJsonFile(_modelsPath) || {};
    for (const m of store[PROVIDER]?.models || []) {
      if ((m.id === MODEL || m.id?.startsWith?.(MODEL)) && m.baseUrl) return String(m.baseUrl).replace(/\/+$/, "");
    }
  } catch {}
  return DEFAULT_BASE;
}

export async function handleAsr(res, body) {
  const data = String(body?.data || "");
  const format = String(body?.format || "webm").toLowerCase().replace(/^audio\//, "").replace(/^x-m4a$/, "m4a");
  if (!data) return json(res, 400, { error: "缺少音频数据（data: base64 字符串）" });
  if (!ALLOWED_FORMATS.has(format)) return json(res, 400, { error: `不支持的音频格式 ${format}（可选：${[...ALLOWED_FORMATS].join("/")}）` });
  if (data.length > MAX_AUDIO_MB * 1024 * 1024 * 1.37) return json(res, 413, { error: `音频过大（上限 ${MAX_AUDIO_MB}MB）` });

  const resolved = _resolveAuth?.(PROVIDER);
  if (!resolved?.key) {
    const fb = await stepfunAsrFallback(data, format);
    if (fb) return json(res, 200, { text: fb, model: "stepaudio-2.5-asr", provider: "stepfun-plan", fallback: true });
    return json(res, 503, { error: `ASR 未配置或不可用：${PROVIDER} 缺少 API Key，备用通道未返回文本` });
  }

  const url = `${resolveBase()}/chat/completions`;
  const payload = {
    model: MODEL,
    messages: [{
      role: "user",
      // ⚠️ 网关约定：只传 audio，不带 text part（"text prompt is injected by the gateway"）
      content: [{ type: "input_audio", input_audio: { data, format } }],
    }],
  };
  try {
    const r = await _httpJsonFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${resolved.key}` },
      body: JSON.stringify(payload),
      timeout: 120000,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      const fb = await stepfunAsrFallback(data, format);
      if (fb) return json(res, 200, { text: fb, model: "stepaudio-2.5-asr", provider: "stepfun-plan", fallback: true });
      return json(res, 502, { error: `ASR 上游失败 ${r.status}: ${txt.slice(0, 200)}` });
    }
    const d = await r.json();
    const text = String(d?.choices?.[0]?.message?.content || "").trim();
    if (!text) {
      const fb = await stepfunAsrFallback(data, format);
      if (fb) return json(res, 200, { text: fb, model: "stepaudio-2.5-asr", provider: "stepfun-plan", fallback: true });
      return json(res, 502, { error: "ASR 未返回文本" });
    }
    return json(res, 200, { text: String(text).trim(), model: MODEL, provider: PROVIDER });
  } catch (e) {
    const fb = await stepfunAsrFallback(data, format);
    if (fb) return json(res, 200, { text: fb, model: "stepaudio-2.5-asr", provider: "stepfun-plan", fallback: true });
    return json(res, 500, { error: `ASR 失败: ${String(e?.message || e).slice(0, 200)}` });
  }
}

// 阶跃备用 ASR（2026-09-20 接入）：mimo 主通道失败时走 step_plan SSE 端点。
// 只吃 wav/mp3（pcm 需额外 rate/bits，前端产物本来就是 wav/mp3）；返回纯文本或 null。
async function stepfunAsrFallback(dataB64, format) {
  try {
    const resolved = _resolveAuth?.("stepfun-plan");
    if (!resolved?.key) return null;
    if (!ALLOWED_FORMATS.has(format)) return null;
    const payload = {
      audio: {
        data: dataB64,
        input: {
          transcription: { model: "stepaudio-2.5-asr", language: "zh", enable_itn: true },
          format: { type: format },
        },
      },
    };
    const r = await _httpJsonFetch("https://api.stepfun.com/step_plan/v1/audio/asr/sse", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${resolved.key}`, Accept: "text/event-stream" },
      body: JSON.stringify(payload),
      timeout: 120000,
    });
    if (!r.ok) return null;
    const out = await r.text().catch(() => "");
    // 只解析 SSE data 帧；JSON 解码保留引号、换行、反斜杠，注释/心跳不进入正文。
    const texts = [];
    for (const frame of out.replace(/\r\n?/g, "\n").split(/\n\n+/)) {
      const data = frame.split("\n").filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).replace(/^ /, "")).join("\n");
      if (!data || data.trim() === "[DONE]") continue;
      const event = JSON.parse(data);
      if (event.error) return null;
      if (typeof event.text === "string") texts.push(event.text);
    }
    const joined = texts.join("").trim();
    return joined || null;
  } catch { return null; }
}
