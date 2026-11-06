import fs from 'node:fs';
import path from 'node:path';

// Poll exact source paths: also catches editors using atomic rename and newly created files.
export function watchMemorySources(root, refresh, interval = 1000) {
  const files = ['记忆.md', '记忆/记忆日志.md', '工程/经验库/experience.md', '记忆/技能记忆.md', '宪法.json']
    .map(relative => path.join(root, relative));
  let timer;
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 40);
    timer.unref();
  };
  for (const file of files) fs.watchFile(file, { persistent: false, interval }, changed);
  refresh();
  return () => {
    clearTimeout(timer);
    for (const file of files) fs.unwatchFile(file, changed);
  };
}
