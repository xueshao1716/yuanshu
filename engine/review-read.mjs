import fs from 'node:fs';

// Callers must validate the workspace path before reading it.
export function readReviewBounded(file, limit) {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error('Invalid review file');
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== stat.size) throw new Error('Review file changed during read');
    return buffer.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
