import path from 'node:path';
import { createHash } from 'node:crypto';
import { reviewStoragePath } from './review-file-safety.mjs';
import { readReviewBounded } from './review-read.mjs';
import { isProtectedPath } from './tools/security.mjs';

export const evidenceHash = value => createHash('sha256').update(value).digest('hex');

// Read-only delivery inspection. Never fetch URLs or interpret tool commands.
export function inspectArtifacts(wsRoot, references) {
  let bytes = 0;
  return [...new Set(references)].slice(0, 21).map(input => {
    let relative = String(input);
    try {
      if (relative.startsWith('/api/ws/file?')) relative = new URL(relative, 'http://local').searchParams.get('path') || '';
      else if (/^https?:|^data:|^file:|^\/\//i.test(relative)) throw new Error('远程或内嵌交付尚无可核对的本地文件');
      if (path.isAbsolute(relative)) relative = path.relative(wsRoot, relative);
      relative = relative.replaceAll('\\', '/');
      const parts = relative.split('/');
      if (!['生成物', '工程', 'workshop-out', '作品', '输出'].includes(parts[0]) ||
          parts.some(p => !p || p.startsWith('.') || /[. ]$/.test(p) || /^(node_modules|待审|运行时|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))
        throw new Error('交付不在允许检查的内容目录内');
      const file = reviewStoragePath(wsRoot, relative);
      if (isProtectedPath(file)) throw new Error('不能将受保护文件当作交付');
      const content = readReviewBounded(file, Math.min(8 * 1024 * 1024, 24 * 1024 * 1024 - bytes));
      bytes += content.length;
      return { path: relative, size: content.length, digest: evidenceHash(content), error: null };
    } catch {
      return { path: relative.slice(0, 500), size: null, digest: null,
        error: '文件缺失、远程交付、路径不允许或超过检查限额（单文件 8MB，总计 24MB）' };
    }
  });
}
