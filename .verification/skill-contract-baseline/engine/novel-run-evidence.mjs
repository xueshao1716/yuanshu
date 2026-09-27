import fs from 'node:fs';
import { createHash } from 'node:crypto';

export function artifactSnapshot(file) {
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    const content = fs.readFileSync(file);
    return { digest: createHash('sha256').update(content).digest('hex'), bytes: content.length, text: content.toString('utf8') };
  } catch { return null; }
}

export function changedArtifact(file, before) {
  const after = artifactSnapshot(file);
  if (!after?.text.trim() || after.digest === before?.digest) return { ok: false, note: '未检测到本次新增或修改的有效产物，旧文件不算本次成功' };
  return { ok: true, digest: after.digest, bytes: after.bytes };
}
