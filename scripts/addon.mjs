#!/usr/bin/env node
// 可选组件命令行：小语缺组件时自己装。
//   node scripts/addon.mjs list
//   node scripts/addon.mjs install media|cutout|data|pdf
import { listAddons, installAddon, ADDONS } from '../engine/addons.mjs';

const [cmd, id] = process.argv.slice(2);
if (cmd === 'list' || !cmd) {
  for (const a of await listAddons()) console.log(`${a.installed ? '[已装]' : '[未装]'} ${a.id.padEnd(7)} ${a.label}  ${a.size}  ${a.use}`);
} else if (cmd === 'install' && id) {
  try {
    const r = await installAddon(id, { log: (m) => console.log(m) });
    if (!r.already && id === 'media') console.log('提示：ffmpeg 装在运行时目录，已加入本进程 PATH；元枢服务里新开的命令立即可用。');
  } catch (e) {
    console.error(`安装失败：${e?.message || e}`);
    process.exit(1);
  }
} else {
  console.log(`用法：node scripts/addon.mjs list | install <${ADDONS.map((a) => a.id).join('|')}>`);
  process.exit(2);
}
