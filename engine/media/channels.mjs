// 宿主密文通道：对话模型不见明文密钥，但能用已配置的图/视频/配音干活。
// 密钥仍只活在 resolveAuth / generateMediaAsync 里。
import { resolveImageRequest } from './request.mjs';
import { imageVerificationNotice } from './dimensions.mjs';

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
      name: "check_model",
      // 2026-11-18：问"某模型通着没"时她没有能用已存密钥测模型的工具，翻了 310 次 auth.json/models-store、撞了 27 次密钥墙
      description: "用宿主已存的密钥测文本模型通不通（发一句极短的话，看是否回复）。问「某模型/通道通着没、能不能用、余额」时直接用它，不要找密钥文件或自己 curl 上游。只传 provider 时测该通道下第一个模型。",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", description: "通道名，如 openrouter、deepseek、zai-coding-cn" },
          modelId: { type: "string", description: "模型 id；不传就测该通道第一个" },
        },
        required: ["provider"],
      },
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
      description: "宿主代持密钥出图。先 list_channels；用户指定 OpenAI/GPT Image 或其他模型时，必须传对应 provider 和 modelId，不能仍用默认通道。未指定时自动选路，限流/服务不可用最多换一个通道，按返回 attempts 和 model 如实说明。画幅必须传 aspect_ratio 或 size；按实际像素汇报，不能裁剪冒充原生成功。不要读密钥或自己 POST /api/image。",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "出图提示词。画**你自己**时不要自己拼外观，改用 subject:\"self\"" },
          subject: { type: "string", enum: ["self"], description: "画小语自己时传 self：外观与画风由人设文件（记忆/外观.md + 形象规则）决定，保证同一张脸" },
          provider: { type: "string", description: "list_channels 中的通道名；指定后不自动换通道" },
          modelId: { type: "string", description: "list_channels 中的模型 id；与 provider 一起传，不可杜撰" },
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
    note: "密钥由宿主代持，调用 check_model / generate_image / generate_video / generate_tts，不要读 auth.json/.token/.env",
    tools: ["list_channels", "check_model", "generate_image", "generate_video", "generate_tts"],
    channels,
  };
}

export function formatSensitiveHint(catalog) {
  const cat = catalog && typeof catalog === "object" ? catalog : listHostChannels();
  const tools = Array.isArray(cat.tools) && cat.tools.length
    ? cat.tools
    : ["list_channels", "check_model", "generate_video", "generate_image", "generate_tts"];
  const lines = (cat.channels || []).map((c) => `${c.provider}/${c.id}（${c.kind}）`);
  return [
    "凭据由宿主代持，对话通道不见明文。这是密文通道，不是死胡同。",
    `请改调：${tools.join(" / ")}（测文本模型通不通用 check_model）`,
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
    if (name === "check_model") return checkModel(args, { getModelList, probe: deps.probeModel });
    // 2026-10-28：subject="self" → 用 persona-look 从人设文件拼提示词（她只决定"画自己"，不用记外观细节）
    let prompt = String(args.prompt || args.text || "").trim();
    if (name === "generate_image" && String(args.subject || "").toLowerCase() === "self") {
      try {
        const { buildSelfPortraitPrompt, seedLookFile } = await import("../persona-look.mjs");
        const root = deps.wsRoot || ".";
        seedLookFile(root);
        prompt = buildSelfPortraitPrompt({ wsRoot: root, extra: prompt });
      } catch {}
    }
    if (!prompt) return { text: "缺少 prompt/text", isError: true };
    if (typeof generate !== "function") return { text: "媒体通道未初始化", isError: true };
    const type = name === "generate_video" ? "video" : name === "generate_image" ? "image" : name === "generate_tts" ? "tts" : "";
    if (!type) return { text: `未知工具: ${name}`, isError: true };
    const intent = { type };
    if (type === 'image') {
      if (args.provider) intent.provider = args.provider;
      if (args.modelId) intent.modelId = args.modelId;
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
    if (r.error && !r.url) return { text: `生成失败：${r.error}${r.attempts?.length ? `；调用记录：${r.attempts.map(a => `${a.model} ${a.status || a.outcome}`).join(' → ')}` : ''}`, isError: true };
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
      text: `${warning}：${r.url}${r.model ? `（${r.model}）` : ""}。${r.attempts?.length > 1 ? `已切换通道：${r.attempts.map(a => `${a.model} ${a.status || a.outcome}`).join(' → ')}。` : ''}${dimensions}${v && v.status !== 'matched' ? '不要宣称比例达标或把单次结果写成通用模型限制；不要擅自裁剪。' : ''}对话播放器会播这条路径。你判断要不要本机打开或复制到交付目录，做完汇报。`,
      media: { type: mediaType, url: r.url, ...(r.model ? { model: r.model } : {}), ...(r.attempts ? { attempts: r.attempts } : {}), ...(v ? { verification: v } : {}) },
    };
  };
}

async function checkModel(args, { getModelList, probe }) {
  const provider = String(args.provider || "").trim();
  if (!provider) return { text: "缺少 provider", isError: true };
  const models = (getModelList() || []).filter(m => m?.provider === provider);
  if (!models.length) {
    const providers = [...new Set((getModelList() || []).map(m => m?.provider).filter(Boolean))];
    return { text: `没有配置通道 ${provider}。已配置：${providers.join("、") || "无"}`, isError: true };
  }
  const id = String(args.modelId || "").trim() || models[0].id;
  if (!models.some(m => m.id === id)) return { text: `${provider} 下没有模型 ${id}。可选：${models.slice(0, 20).map(m => m.id).join("、")}`, isError: true };
  if (typeof probe !== "function") return { text: "模型探测未初始化", isError: true };
  const started = Date.now();
  try {
    const r = await probe({ provider, id });
    const ms = Date.now() - started;
    return r?.ok
      ? { text: `✅ ${provider}/${id} 通着：${ms}ms 内回复${r.usedModel && r.usedModel !== id ? `（上游实际模型 ${r.usedModel}）` : ""}。` }
      : { text: `❌ ${provider}/${id} 不通（${ms}ms）：${r?.error || "无回复"}`, isError: true };
  } catch (e) {
    return { text: `❌ ${provider}/${id} 不通：${String(e?.message || e).slice(0, 200)}`, isError: true };
  }
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
