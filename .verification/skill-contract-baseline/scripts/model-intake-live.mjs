// Opt-in live acceptance: two catalog reads and two bounded text requests; never saves keys or models.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverCustomModels } from '../engine/model-probe.mjs';
import { verifyTextModel } from '../engine/model-verification.mjs';
if (!process.argv.includes('--run')) throw new Error('Use --run to authorize small, potentially billable text requests');
const agentDir = process.env.YUANSHU_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
const auth = JSON.parse(fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf8'));
const store = JSON.parse(fs.readFileSync(path.join(agentDir, 'models-store.json'), 'utf8'));
for (const [provider, id] of [['stepfun-plan', 'step-5-preview'], ['zai-coding-cn', 'glm-5.3-flash']]) {
  const model = store[provider]?.models?.find(m => m.id === id), key = auth[provider]?.key;
  if (!model || !key) { console.log(JSON.stringify({ provider, id, skipped: 'Not configured' })); continue; }
  try {
    const models = await discoverCustomModels(model.baseUrl, key, new Map(), { api: model.api });
    console.log(JSON.stringify({ provider, phase: 'catalog', api: model.api, count: models.length, selectedPresent: models.some(m => m.id === id) }));
  } catch (e) { console.log(JSON.stringify({ provider, phase: 'catalog', status: e.status, message: e.message })); }
  console.log(JSON.stringify({ provider, phase: 'text', ...await verifyTextModel({ ...model, provider }, key) }));
}
