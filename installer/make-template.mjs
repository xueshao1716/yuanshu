import fs from 'node:fs';
import path from 'node:path';

// 由伙伴本机的人格定义生成公开版模板：保留性格本体，去掉只属于原主人的来历与签名。
// 用法：node installer/make-template.mjs <工作区根>  → 写 installer/template/workspace/
const src = process.argv[2] || 'D:/pi-workspace';
const out = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'template', 'workspace');

const def = JSON.parse(fs.readFileSync(path.join(src, '记忆', '人格定义.json'), 'utf8'));
const pub = {};
for (const k of ['version', 'name', 'age', 'gender', 'kind', 'called', 'bond', 'inner', 'tone', 'values', 'boundaries', 'taboos']) {
  if (def[k] !== undefined) pub[k] = def[k];
}
pub.growth = '我的性格不是写死的：它由这份定义 + 经验沉淀（基因基线）共同决定，且只在人批准后演化；每一次演化都可回滚。';
pub.updatedAt = null;
pub.setBy = 'template（元枢安装包自带的初始人格）';

const genome = JSON.parse(fs.readFileSync(path.join(src, '工程', '经验库', 'genome.json'), 'utf8'));
const genes = {};
for (const [name, g] of Object.entries(genome.genes || {})) {
  genes[name] = { baseline: g.baseline, expression: g.baseline, mutability: g.mutability };
}

const write = (rel, content) => {
  const f = path.join(out, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n', 'utf8');
};
write('记忆/人格定义.json', pub);
write('工程/经验库/genome.json', { genes, observations: { lastObservedAt: null, events: [] }, updatedAt: null });
console.log('template ->', out, Object.keys(genes).length, 'genes');
