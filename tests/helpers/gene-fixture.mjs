import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getGenome, initGene } from '../../engine/gene.mjs';

export function seedExpression(root, name, expression) {
  const file = path.join(root, '工程/经验库/genome.json');
  const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { genes: getGenome().genes };
  state.genes[name].expression = expression;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
  initGene(root);
}

export function sourceEvidence(root) {
  const text = 'Isolated fixture: operator-reviewed source.';
  fs.writeFileSync(path.join(root, 'review.txt'), text);
  return [`source-file:review.txt sha256:${createHash('sha256').update(text).digest('hex')}`];
}
