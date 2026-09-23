import { httpRawFetch } from './http.mjs';

// 只读像素头，不执行解码器，也不把核验失败猜成“上游不支持”。
export function readImageDimensions(bytes) {
  const b = Buffer.from(bytes);
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && b.toString('ascii', 12, 16) === 'IHDR') {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i++] !== 0xff) return null;
      while (b[i] === 0xff) i++;
      const marker = b[i++];
      if (marker === 0xda || marker === 0xd9) return null;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (i + 2 > b.length) return null;
      const len = b.readUInt16BE(i);
      if (len < 2 || i + len > b.length) return null;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && len >= 7) {
        return { width: b.readUInt16BE(i + 5), height: b.readUInt16BE(i + 3) };
      }
      i += len;
    }
  }
  if (b.length >= 25 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8X' && b.length >= 30) return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
    if (kind === 'VP8 ' && b.length >= 30 && b.subarray(23, 26).equals(Buffer.from('9d012a', 'hex'))) return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L' && b[20] === 0x2f) {
      const n = b.readUInt32LE(21);
      return { width: (n & 0x3fff) + 1, height: ((n >>> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

async function imageHeader(url) {
  if (url.startsWith('data:image/')) return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').subarray(0, 262144);
  if (!/^https?:\/\//i.test(url)) return null;
  // 远端只需读头部；限制流量与总耗时，不能为了核验再挂起一个长任务。
  const response = await httpRawFetch(url, { headers: { Range: 'bytes=0-262143' }, signal: AbortSignal.timeout(10000), timeout: 10000 });
  if (!response.ok || !response.body) { await response.body?.cancel(); return null; }
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (length < 262144) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value).subarray(0, 262144 - length);
      chunks.push(chunk); length += chunk.length;
      const bytes = Buffer.concat(chunks);
      if (readImageDimensions(bytes)) return bytes;
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); }
}

export async function verifyImageDimensions(url, requestedSize, requestedAspectRatio) {
  const result = { requestedSize, ...(requestedAspectRatio ? { requestedAspectRatio } : {}), status: 'unverified' };
  try {
    const bytes = await imageHeader(url);
    const dimensions = bytes && readImageDimensions(bytes);
    if (!dimensions?.width || !dimensions?.height) return result;
    const { width, height } = dimensions;
    const [w, h] = requestedSize.split('x').map(Number);
    const [rw, rh] = requestedAspectRatio ? requestedAspectRatio.split(':').map(Number) : [w, h];
    return { ...result, actualSize: `${width}x${height}`, width, height,
      exactSize: width === w && height === h,
      ratioExact: width * rh === height * rw,
      status: Math.abs(width / height / (rw / rh) - 1) <= 0.01 ? 'matched' : 'mismatch' };
  } catch { return result; }
}

export function imageVerificationNotice(v) {
  if (!v) return '';
  const facts = `请求 ${v.requestedSize}${v.requestedAspectRatio ? `（${v.requestedAspectRatio}）` : ''}；实际 ${v.actualSize || '未核验'}。`;
  const verdict = v.status === 'unverified' ? '像素尚未核验，不能宣称画幅达标。'
    : v.status === 'mismatch' ? '画幅未达标。'
    : `${v.ratioExact ? '比例精确匹配' : '比例近似匹配（误差不超过1%，不等于严格同比例）'}；${v.exactSize ? '像素一致' : '像素尺寸不同'}。`;
  return facts + verdict + '不要把单次结果写成通用模型限制，不要擅自裁剪冒充原生成功。';
}
