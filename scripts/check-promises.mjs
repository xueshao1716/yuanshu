#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pendingPromises, promisePaths } from '../engine/promises.mjs';

export function scanPromises(workspace, { now = new Date() } = {}) {
  const file = promisePaths(workspace).file;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data) || data.some(p => !p || typeof p.text !== 'string' || !p.status)) {
    throw new Error('承诺账格式无效，未统计为零');
  }
  const pending = pendingPromises(workspace, { now, fsMod: {
    existsSync: () => true, readFileSync: () => JSON.stringify(data),
  } });
  const overdue = pending.filter(p => p.age.overdue);
  return {
    total: data.length, pending: pending.length, overdue: overdue.length,
    policy: '仅 pending；明确日期后宽限24小时；无日期积压超过7天',
    items: overdue.map(p => ({ id: p.id, text: p.text, due: p.due || null,
      status: p.status, age: p.age, note: p.note || '' })),
  };
}

export function main(args = process.argv.slice(2)) {
  try {
    const index = args.indexOf('--workspace');
    if (index >= 0 && (!args[index + 1] || args[index + 1].startsWith('--'))) throw new Error('--workspace 缺少目录');
    const workspace = index >= 0 ? args[index + 1] : process.cwd();
    const result = scanPromises(workspace);
    console.log(args.includes('--json') ? JSON.stringify(result, null, 2)
      : `待兑现 ${result.pending} 条，逾期 ${result.overdue} 条（${result.policy}）\n${result.items.map(p => `- ${p.text}（${p.age.phrase}）`).join('\n')}`);
    return 0;
  } catch (error) {
    console.error(`承诺扫描失败：${error.message}`);
    return 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
