import path from 'node:path';
import { readImageDimensions } from './image-dimensions.mjs';

// Structural observations only: no network, code execution, or claim of task quality.
export function inspectArtifactBytes(file, bytes) {
  const result = (status, scope, message, facts = {}) => ({ version: 1, status, scope, message, ...facts });
  if (!bytes.length) return result('FAIL', 'nonempty', '文件为空');
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') {
    try { JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { return result('FAIL', 'json-syntax', 'JSON 语法或 UTF-8 编码无效'); }
    return result('PASS', 'json-syntax', '仅确认 JSON 可解析，未核对内容是否符合任务');
  }
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
    const matches = ext === '.png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) :
      ext === '.webp' ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' :
        bytes[0] === 255 && bytes[1] === 216;
    let size;
    try { size = matches && readImageDimensions(bytes); } catch { /* Invalid header. */ }
    if (!size?.width || !size?.height) return result('FAIL', 'image-header', '图片类型或像素头无效');
    return result('PASS', 'image-header', '仅核对图片头与像素；未完整解码，也未验收画面或目标比例', size);
  }
  return result('UNVERIFIED', 'unsupported', '已记录文件指纹；此格式尚无自动内容验收');
}

export function summarizeObjective(artifacts) {
  const failed = artifacts.some(a => a.error || a.objective?.status === 'FAIL');
  return { version: 1, status: failed ? 'FAIL' : artifacts.length && artifacts.every(a => a.objective?.status === 'PASS') ? 'PASS' : 'UNVERIFIED',
    artifacts: artifacts.map(a => ({ path: a.path, digest: a.digest, ...a.objective })) };
}
