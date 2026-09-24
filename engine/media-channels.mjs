// 宿主密文通道：对话模型不见明文密钥，但能用已配置的图/视频/配音干活。
// 密钥仍只活在 resolveAuth / generateMediaAsync 里。
import { resolveImageRequest } from './image-request.mjs';
import { imageVerificationNotice } from './image-dimensions.mjs';

export const MEDIA_TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "list_channels",
      description: "列出宿主已配置的媒体密文通道（图/视频/配音）。只返回通道名和能力，不含密钥。做视频/配音/出图先看这里，再调 generate_video / generate_image / generate_tts。不要读 auth.json/.token/.env。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_video",
      description: "宿主代持密钥生成视频。写好脚本后直接调用。生成后对话里会播；要本机打开或复制到交付/分享目录，你判断并汇报。",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "视频提示词或分镜脚本" },
          mode: { type: "string", description: "text（默认）/ keyframe / reference" },
          seconds: { type: "string", description: "时长 4-12，默认 5" },
          size: { type: "string", description: "720P / 960P / 2K" },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description: "宿主代持密钥出图。有画幅要求时必须传 aspect_ratio 或 size，不能只写在提示词里。按返回的尺寸核验事实汇报，未达标不能自行裁剪冒充原生成功。不要读密钥，不要自己 POST /api/image。",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "出图提示词" },
          size: { type: "string", description: "请求像素宽x高，如 1024x1536；上游是否支持以实际返回为准" },
          aspect_ratio: { type: "string", description: "请求画幅，如 1:1、2:3、3:2、3:4、4:3、4:5、5:4、16:9、9:16、21:9" },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_tts",
      description: "宿主代持密钥配音（mimo TTS）。不要读密钥。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "要朗读的文本" },
          prompt: { type: "string", description: "同 text，兼容别名" },
        },
      },
    },
  },
];

export function listHostChannels({ getModelList } = {}) {
  const list = typeof getModelList === "function" ? getModelList() : [];
  const channels = [];
  for (const m of list || []) {
    const caps = m?.capabilities || {};
    for (const kind of ["image", "video", "tts"]) {
      if (caps[kind]) channels.push({ kind, provider: m.provider, id: m.id });
    }
  }
  return {
    note: "密钥由宿主代持，调用 generate_image / generate_video / generate_tts，不要读 auth.json/.token/.env",
    tools: ["list_channels", "generate_image", "generate_video", "generate_tts"],
    channels,
  };
}

export function formatSensitiveHint(catalog) {
  const cat = catalog && typeof catalog === "object" ? catalog : listHostChannels();
  const tools = Array.isArray(cat.tools) && cat.tools.length
    ? cat.tools
    : ["list_channels", "generate_video", "generate_image", "generate_tts"];
  const lines = (cat.channels || []).map((c) => `${c.provider}/${c.id}（${c.kind}）`);
  return [
    "凭据由宿主代持，对话通道不见明文。这是密文通道，不是死胡同。",
    `请改调：${tools.join(" / ")}`,
    lines.length ? `当前可用：${lines.join("、")}` : "当前可用通道见 list_channels",
    "不要读 auth.json/.token/.env，也不要自己 curl 上游。",
  ].join("\n");
}

export function createMediaToolExecutor(deps = {}) {
  const getModelList = deps.getModelList || (() => []);
  const generate = deps.generateMediaAsync;
  return async function mediaToolExecutor(name, args = {}) {
    if (name === "list_channels") {
      return { text: JSON.stringify(listHostChannels({ getModelList }), null, 2) };
    }
    const prompt = String(args.prompt || args.text || "").trim();
    if (!prompt) return { text: "缺少 prompt/text", isError: true };
    if (typeof generate !== "function") return { text: "媒体通道未初始化", isError: true };
    const type = name === "generate_video" ? "video" : name === "generate_image" ? "image" : name === "generate_tts" ? "tts" : "";
    if (!type) return { text: `未知工具: ${name}`, isError: true };
    const intent = { type };
    if (type === 'image') {
      try { Object.assign(intent, resolveImageRequest(args, prompt)); }
      catch (e) { return { text: e.message, isError: true }; }
    }
    if (type === "video") {
      if (args.mode) intent.mode = args.mode;
      if (args.seconds != null) intent.seconds = args.seconds;
      if (args.size) intent.size = args.size;
    }
    const r = await generate(intent, prompt);
    if (!r) return { text: "宿主未返回产物（可能未配置对应模型）", isError: true };
    if (r.error && !r.url) return { text: `生成失败：${r.error}`, isError: true };
    if (!r.url) return { text: "生成完成但未返回 URL", isError: true };
    const mediaType = r.type === "tts" ? "audio" : (r.type || type);
    const v = r.verification;
    const dimensions = imageVerificationNotice(v);
    const warning = mediaType !== 'image' ? '✅ 已生成 ' + mediaType
      : !v || v.status === 'unverified' ? '⚠️ 已返回图片，像素尚未核验'
      : v.status === 'mismatch' ? '⚠️ 已返回图片，但画幅未达标'
      : v.exactSize === false ? '⚠️ 已返回图片，但像素尺寸未达标'
      : v.exactSize !== true ? '⚠️ 已返回图片，像素尚未核验' : '✅ 已生成 image';
    return {
      text: `${warning}：${r.url}${r.model ? `（${r.model}）` : ""}。${dimensions}${v && v.status !== 'matched' ? '不要宣称比例达标或把单次结果写成通用模型限制；不要擅自裁剪。' : ''}对话播放器会播这条路径。你判断要不要本机打开或复制到交付目录，做完汇报。`,
      media: { type: mediaType, url: r.url, ...(v ? { verification: v } : {}) },
    };
  };
}

export function mediaExtraExecutors(deps = {}) {
  const exec = createMediaToolExecutor(deps);
  const out = {};
  for (const s of MEDIA_TOOL_SCHEMAS) {
    const name = s.function.name;
    out[name] = (args, ctx) => exec(name, args, ctx);
  }
  return out;
}
