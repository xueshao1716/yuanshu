// Opt-in, bounded paid smoke test. Credentials stay in the host; outputs are isolated.
import fs from 'node:fs';
import path from 'node:path';
import { defaultFallbackAgentDir } from '../engine/pi-compat-fallback.mjs';
import { initMediaApi, generateMediaAsync } from '../engine/media-api.mjs';
import { createMediaToolExecutor } from '../engine/media-channels.mjs';
const dir = defaultFallbackAgentDir();
const auth = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
const store = JSON.parse(fs.readFileSync(path.join(dir, 'models-store.json'), 'utf8'));
const size = process.argv[2] || '1024x1536';
if (!/^\d{3,4}x\d{3,4}$/.test(size)) throw new Error('invalid test size');
const out = path.resolve('tmp/media-fix-20260923/live');
fs.mkdirSync(out, { recursive: true });
initMediaApi({ resolveAuth: p => auth[p], readJsonFile: () => store,
  getModelList: () => [{ provider: 'agnes', id: 'agnes-image-2.5-flash', capabilities: { image: true } }] });
const started = Date.now();
try {
  const executor = createMediaToolExecutor({ generateMediaAsync });
  const result = await executor('generate_image', {
    prompt: `A single green leaf on white, minimalist photography, no text. Image dimensions ${size}.`, size });
  if (!result.media?.url) throw new Error(result.text);
  const url = result.media.url;
  const bytes = url.startsWith('data:') ? Buffer.from(url.split(',')[1], 'base64')
    : Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(30000) })).arrayBuffer());
  const file = path.join(out, `agnes-${size}-${Date.now()}.png`);
  fs.writeFileSync(file, bytes);
  const png = bytes.subarray(1, 4).toString() === 'PNG';
  console.log(JSON.stringify({ requestedSize: size, actualSize: png ? `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}` : 'inspect file', verification: result.media.verification, bytes: bytes.length, file, elapsedMs: Date.now() - started }));
} catch (e) { console.error(String(e.message).replace(/sk-[\w.-]+/g, '[redacted]')); process.exitCode = 1; }
