// engine/model/defaults.mjs —— 模型中心「默认设置」：默认模型 / 兜底顺序 / 每日 token 预算（2026-11-19）
//
// 三样东西原来散在三处，只能改文件：
//   默认模型   ~/.pi/agent/settings.json 的 defaultProvider/defaultModel（启动时读进 CONFIG.model）
//   兜底顺序   写死在 router.mjs 的几条链里
//   每日预算   记忆/运行时/token预算.json
// 这里统一读写，改完立即生效，不用重启。
import fs from 'node:fs';
import path from 'node:path';
import { isTextCapableModel } from './router.mjs';

export const FALLBACKS_FILE = 'model-fallbacks.json';
const BUDGET_FILE = ['记忆', '运行时', 'token预算.json'];
const MAX_FALLBACKS = 10;

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {} } catch { return {} } };
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
};
const keyOf = (m) => (m ? `${m.provider}/${m.id}` : '');
const invalid = (message) => Object.assign(new Error(message), { localStatus: 400 });

export function readUserFallbacks(agentDir) {
  const list = readJson(path.join(agentDir, FALLBACKS_FILE)).fallbacks;
  return Array.isArray(list) ? list.map(String).filter((k) => k.includes('/')).slice(0, MAX_FALLBACKS) : [];
}

/**
 * @param {object} o
 * @param {string} o.agentDir        ~/.pi/agent
 * @param {string} o.wsRoot          工作区
 * @param {() => any[]} o.getModelList
 * @param {() => any} o.getDefaultModel
 * @param {(m:any) => void} o.setDefaultModel   换默认模型（server 里同时改 CONFIG.model）
 * @param {(list:string[]) => void} o.setFallbacks
 * @param {() => {total:number}} [o.todayUsage]
 */
export function createModelDefaults({ agentDir, wsRoot, getModelList, getDefaultModel, setDefaultModel, setFallbacks, todayUsage = () => ({ total: 0 }) }) {
  const settingsFile = path.join(agentDir, 'settings.json');
  const fallbacksFile = path.join(agentDir, FALLBACKS_FILE);
  const budgetFile = path.join(wsRoot, ...BUDGET_FILE);
  const find = (key) => (getModelList() || []).find((m) => keyOf(m) === key);

  function get() {
    const b = readJson(budgetFile);
    return {
      defaultModel: keyOf(getDefaultModel()),
      fallbacks: readUserFallbacks(agentDir),
      budget: {
        enabled: b.enabled !== false,
        dailyTokens: Number(b.dailyTokens) || 3_000_000,
        downgrade: b.downgrade !== false,
        usedToday: Number(todayUsage()?.total) || 0,
      },
    };
  }

  function save(body = {}) {
    // 先全部校验，再落盘：一项不对整体不改
    let model = null;
    if (body.defaultModel !== undefined) {
      model = find(String(body.defaultModel));
      if (!model) throw invalid('默认模型不在当前模型列表里');
      if (!isTextCapableModel(model)) throw invalid('默认模型必须能做文本对话（不能选出图/视频模型）');
    }
    let fallbacks = null;
    if (body.fallbacks !== undefined) {
      if (!Array.isArray(body.fallbacks)) throw invalid('兜底模型必须是列表');
      fallbacks = [...new Set(body.fallbacks.map(String))];
      if (fallbacks.length > MAX_FALLBACKS) throw invalid(`兜底模型最多 ${MAX_FALLBACKS} 个`);
      const bad = fallbacks.find((k) => { const m = find(k); return !m || !isTextCapableModel(m) });
      if (bad) throw invalid(`兜底模型不可用或不能做文本：${bad}`);
    }
    let budget = null;
    if (body.dailyTokens !== undefined || body.downgrade !== undefined || body.budgetEnabled !== undefined) {
      budget = readJson(budgetFile);
      if (body.dailyTokens !== undefined) {
        const n = Number(body.dailyTokens);
        if (!Number.isInteger(n) || n < 100_000 || n > 100_000_000_000) throw invalid('每日预算要在 10 万到 1000 亿 token 之间');
        budget.dailyTokens = n;
      }
      if (body.downgrade !== undefined) budget.downgrade = body.downgrade === true;
      if (body.budgetEnabled !== undefined) budget.enabled = body.budgetEnabled === true;
    }

    if (model) {
      const s = readJson(settingsFile);
      writeJson(settingsFile, { ...s, defaultProvider: model.provider, defaultModel: model.id });
      setDefaultModel(model);
    }
    if (fallbacks) {
      writeJson(fallbacksFile, { fallbacks });
      setFallbacks(fallbacks);
    }
    if (budget) writeJson(budgetFile, budget);
    return get();
  }

  return { get, save };
}
