import { httpBufferFetch } from './http.mjs';
import { json } from './http-utils.mjs';
import { speechVoice } from './speech-voice.mjs';
import { streamReplyTts } from './reply-tts-stream.mjs';
import { observeMediaRequest, recordMediaFailure } from './media-observations.mjs';

const MODEL = 'stepaudio-2.5-tts';
const VOICE = speechVoice.id;
const VOICE_LABEL = speechVoice.label;
const problem = (message, status = 502) => Object.assign(new Error(message), { status });

// Reply playback is separate from creative media: no silent provider fallback or artifact write.
export function createReplyTts({ getModelList, readStore, resolveAuth, request = httpBufferFetch, connectStream }) {
  let active = 0;
  function configured() {
    for (const m of getModelList()) {
      if (m.id !== MODEL) continue;
      const auth = resolveAuth(m.provider);
      if (!auth?.key) continue;
      const base = m.baseUrl || readStore()[m.provider]?.baseUrl || auth.baseUrl || 'https://api.stepfun.com/step_plan/v1';
      return { model: m.id, provider: m.provider, key: auth.key, endpoint: `${base.replace(/\/+$/, '')}/audio/speech` };
    }
    return null;
  }
  function capabilities() {
    const config = configured();
    return config ? { available: true, model: config.model, provider: config.provider, voice: VOICE, voiceLabel: VOICE_LABEL, maxChars: 2000, streaming: true }
      : { available: false, reason: '未配置可用的阶跃语音模型或密钥' };
  }
  async function synthesize(body, { signal } = {}) {
    if (typeof body?.text !== 'string' || !body.text.trim()) throw problem('请提供朗读正文', 400);
    const text = body.text.trim();
    if (text.length > 2000) throw problem('单段正文最多 2000 字，请分段朗读', 400);
    const config = configured();
    if (!config) throw problem('未配置可用的阶跃语音模型或密钥', 503);
    if (active >= 2) throw problem('语音合成繁忙，请稍后重试', 429);
    active++;
    const observation = {kind:'tts',provider:config.provider,model:config.model,phase:'reply',signal};
    try {
      const response = await observeMediaRequest(observation, () => request(config.endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.key}` },
        body: JSON.stringify({ model: config.model, input: text, voice: VOICE, response_format: 'mp3' }),
        timeout: 60000, signal,
      }));
      if (!response.ok) throw problem(`阶跃语音请求失败（HTTP ${response.status}），请检查通道额度或稍后重试`, response.status === 429 ? 429 : 502);
      const bytes = response.buffer();
      if (!bytes || bytes.length < 100 || bytes.length > 20 * 1024 * 1024 ||
        !(bytes.subarray(0, 3).toString() === 'ID3' || (bytes[0] === 255 && (bytes[1] & 224) === 224))) {
        recordMediaFailure(observation, {code:'invalid_response'});
        throw problem('阶跃未返回有效 MP3 音频，请重试');
      }
      return { bytes, model: config.model, provider: config.provider };
    } catch (error) {
      if (error.status) throw error;
      throw problem(/timeout/i.test(error.message) ? '阶跃语音合成超时，请重试' : '阶跃语音网络连接失败，请重试');
    } finally { active--; }
  }
  async function handle(res, body) {
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    res.once('close', disconnect);
    try {
      if (res.destroyed) return;
      const result = await synthesize(body, { signal: controller.signal });
      if (res.destroyed || controller.signal.aborted) return;
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': result.bytes.length, 'Cache-Control': 'no-store',
        'X-TTS-Model': result.model, 'X-TTS-Provider': result.provider });
      res.end(result.bytes);
    } catch (error) {
      if (!res.destroyed && !controller.signal.aborted) json(res, error.status || 502, { error: error.message });
    } finally { res.off('close', disconnect); }
  }
  async function handleStream(res, body) {
    let acquired = false;
    try {
      if (res.destroyed) return;
      if (typeof body?.text !== 'string' || !body.text.trim() || body.text.length > 200) throw problem('流式正文需为 1–200 字', 400);
      const config = configured();
      if (!config) throw problem('未配置可用的阶跃语音模型或密钥', 503);
      if (active >= 2) throw problem('语音合成繁忙，请稍后重试', 429);
      active++; acquired = true;
      await observeMediaRequest({kind:'tts',provider:config.provider,model:config.model,phase:'reply_stream'},
        () => streamReplyTts({ config, text: body.text.trim(), res, connect: connectStream }));
    } catch (error) {
      if (!res.destroyed) {
        if (res.headersSent) { res.write(JSON.stringify({ type: 'error', error: error.message }) + '\n'); res.end(); }
        else json(res, error.status || 502, { error: error.message });
      }
    } finally { if (acquired) active--; }
  }
  return { capabilities, synthesize, handle, handleStream };
}
