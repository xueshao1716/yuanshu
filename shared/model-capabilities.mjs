// Name-based inference is a catalog hint, never proof of upstream availability.
const specialized = ['image', 'video', 'tts', 'asr', 'realtime'];
export function modelCapabilities(id = '') {
  const name = String(id);
  const caps = {
    chat: true,
    image: /image|(?:^|[\/._-])flux(?:[\/._-]|$)|seedream|stable-diffusion|dall-e/i.test(name),
    video: /video|(?:^|[\/._-])(?:wan\d|sora(?:[._-]|$)|veo(?:[._-]|$))|[ti]2v/i.test(name),
    tts: /tts/i.test(name),
    asr: /asr|whisper|transcribe/i.test(name),
    realtime: /realtime/i.test(name),
  };
  if (caps.video) caps.image = false;
  if (caps.realtime) { caps.tts = false; caps.asr = false; }
  caps.chat = !specialized.some(kind => caps[kind]);
  // These flags describe parameters our media pipeline forwards, not compliance guarantees.
  if (caps.image || caps.video) { caps.reference = true; caps.seed = true; }
  if (caps.video) caps.keyframe = true;
  return caps;
}

export function effectiveCapabilities(model, infer = modelCapabilities) {
  const raw = model?.capabilities;
  const explicit = Array.isArray(raw) ? Object.fromEntries(raw.filter(k => typeof k === 'string').map(k => [k, true]))
    : Object.fromEntries(Object.entries(raw || {}).filter(([, value]) => typeof value === 'boolean'));
  const caps = { ...infer(model?.id), ...explicit };
  if (!Object.hasOwn(explicit, 'chat') && specialized.some(kind => caps[kind])) caps.chat = false;
  return caps;
}

export const isTextModel = model => model?.enabled !== false && effectiveCapabilities(model).chat === true;
export const isChatSelectable = model => model?.enabled !== false && ['chat', 'image', 'video'].some(kind => effectiveCapabilities(model)[kind] === true);
