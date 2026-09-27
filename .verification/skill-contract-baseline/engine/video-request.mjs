// Agnes 视频创建体：2.5 官方必填 mode（text|keyframe|reference）。
// 2.0 不强制。非法 mode（text-to-video / pro）回落到 text，避免模型把词写进 prompt。

const MODES = new Set(["text", "keyframe", "reference"]);

export function videoNeedsMode(modelId) {
  return /2\.5/.test(String(modelId || ""));
}

export function videoCreateBody(modelId, prompt, extra = {}) {
  const id = String(modelId || "");
  const src = extra && typeof extra === "object" ? extra : {};
  const body = { model: id, prompt: String(prompt || "") };
  let mode = MODES.has(src.mode) ? src.mode : "";
  if (!mode && (src.first_frame || src.last_frame)) mode = "keyframe";
  if (!mode && hasRefs(src)) mode = "reference";
  if (!mode && videoNeedsMode(id)) mode = "text";
  if (mode) body.mode = mode;
  if (src.seconds != null && src.seconds !== "") body.seconds = String(src.seconds);
  if (src.size) body.size = String(src.size);
  if (src.aspect_ratio) body.aspect_ratio = String(src.aspect_ratio);
  if (src.width) body.width = +src.width;
  if (src.height) body.height = +src.height;
  if (src.num_frames) body.num_frames = +src.num_frames;
  if (src.frame_rate) body.frame_rate = +src.frame_rate;
  if (src.image) body.image = src.image;
  if (src.first_frame) body.first_frame = src.first_frame;
  if (src.last_frame) body.last_frame = src.last_frame;
  if (Array.isArray(src.images) && src.images.length) body.images = src.images;
  if (Array.isArray(src.audios) && src.audios.length) body.audios = src.audios;
  if (Array.isArray(src.videos) && src.videos.length) body.videos = src.videos;
  if (src.seed != null && src.seed !== "") body.seed = +src.seed;
  return body;
}

export function videoPollPath(taskId, modelId) {
  const q = new URLSearchParams({ video_id: String(taskId || "") });
  // 2026-09-20 实测：v2.0 轮询带 model_name 也通过（2.5 必需），有 modelId 就带，无害
  if (modelId) q.set("model_name", String(modelId));
  return `/agnesapi?${q}`;
}

// agnes 创建响应的 video_id 是 litellm 包装的 base64：
// video_bGl0ZWxsbTp... 解码后内含 "video_id:video_c07d544..."，那才是 v2.0 通道的轮询键。
// （2026-09-20 实测：v2.0 用 task_id 轮询 404 会被当 pending 永久死锁；2.5 通道仍用 task_id。）
export function decodeAgnesVideoId(rawVideoId) {
  try {
    const s = String(rawVideoId || "");
    if (!s.startsWith("video_")) return "";
    let b64 = s.slice(6);
    b64 += "=".repeat((4 - (b64.length % 4)) % 4);
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    const m = decoded.match(/video_id:([^;\s]+)/);
    return m ? m[1] : "";
  } catch { return ""; }
}

// 创建 400 时由宿主补缺字段再试一次，不要把坑丢回给模型猜。
export function repairVideoRequest(modelId, prompt, extra = {}, error = "") {
  const msg = String(error || "");
  const src = extra && typeof extra === "object" ? extra : {};
  const patch = {};
  if (/mode/i.test(msg) && !MODES.has(src.mode)) patch.mode = "text";
  if (/seconds/i.test(msg) && (src.seconds == null || src.seconds === "")) patch.seconds = "5";
  if (/size/i.test(msg) && !src.size) patch.size = "720P";
  if (!Object.keys(patch).length) return null;
  return videoCreateBody(modelId, prompt, { ...src, ...patch });
}

function hasRefs(src) {
  return (Array.isArray(src.images) && src.images.length)
    || (Array.isArray(src.audios) && src.audios.length)
    || (Array.isArray(src.videos) && src.videos.length);
}
