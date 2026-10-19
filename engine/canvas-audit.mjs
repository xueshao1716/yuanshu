// engine/canvas-audit.mjs —— 画布巡检
//
// 2026-10-19 伙伴：「新上线了 lovart 2 很强」→ 核实后最值得抄的是它的**画布巡检**：
// 拿"最初的需求/规范"去核当前画布，偏离就预警。它抓到过成品 1920×1088 与 16:9 差 8 像素这种事——
// 这正是"可用交付"和"抽卡"的分水岭。
//
// 设计原则：
//   · 不调模型，纯规则核对（可测、可解释、零成本）；
//   · 只报"确定偏离"和"确定缺失"，不猜审美；
//   · 尺寸类结论来自真实文件头（image-dimensions.mjs），不是提示词里的自述。

import fs from 'node:fs';
import path from 'node:path';
import { readImageDimensions, verifyImageDimensions } from './image-dimensions.mjs';

export const AUDIT_LEVELS = ['error', 'warn', 'info'];
const MAX_TEXT = 2000;

const arr = (v, max = 20) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).slice(0, max).map((x) => x.trim()) : []);

/** 规范（brief）只收四类可核对的东西，别让自由文本混进来当规则。 */
export function normalizeBrief(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  return {
    deliverables: arr(b.deliverables, 12),
    requiredText: arr(b.requiredText, 12),
    forbidden: arr(b.forbidden, 20),
    ratios: b.ratios && typeof b.ratios === 'object'
      ? Object.fromEntries(Object.entries(b.ratios).filter(([, v]) => Number.isFinite(Number(v)) && Number(v) > 0).slice(0, 8).map(([k, v]) => [String(k).slice(0, 40), Number(v)]))
      : {},
  };
}

export function briefIsEmpty(brief) {
  const b = normalizeBrief(brief);
  return !b.deliverables.length && !b.requiredText.length && !b.forbidden.length && !Object.keys(b.ratios).length;
}

const mediaNodes = (doc) => (doc?.nodes || []).filter((n) => n.kind === 'image' || n.kind === 'video');
const promptOf = (doc, node) => {
  // 自己写的优先；没写就看连进来的提示词节点（画布语义与前端一致）
  if (String(node.text || '').trim()) return String(node.text);
  const edge = (doc?.edges || []).find((e) => e.to === node.id && e.kind === 'prompt');
  const up = edge && (doc?.nodes || []).find((n) => n.id === edge.from);
  return String(up?.text || '');
};
const allText = (doc) => (doc?.nodes || []).map((n) => String(n.text || '')).join('\n').slice(0, MAX_TEXT);
const label = (n) => `${n.kind}${n.title && n.title !== n.kind ? `「${n.title}」` : ''}(${n.id})`;

/** 纯规则部分：不碰文件、不联网，可单测。 */
export function auditCanvasDoc(doc, { brief } = {}) {
  const issues = [];
  const add = (level, code, message, nodeId) => issues.push({ level, code, message, ...(nodeId ? { nodeId } : {}) });
  const nodes = doc?.nodes || [];

  if (!nodes.length) add('warn', 'empty_canvas', '画布还是空的：先让提示词/配置/图片节点连起来再巡检。');

  for (const n of mediaNodes(doc)) {
    if (!promptOf(doc, n).trim()) add('error', 'media_without_prompt', `${label(n)} 没有提示词：自己写一段，或连一个提示词节点进来。`, n.id);
    if (!n.provider || !n.modelId) add('error', 'media_without_model', `${label(n)} 没选模型：连一个配置节点，或在节点上直接选。`, n.id);
    if (!String(n.url || '').trim()) add('warn', 'media_not_generated', `${label(n)} 还没生成出结果。`, n.id);
  }

  const b = normalizeBrief(brief);
  if (!briefIsEmpty(b)) {
    const text = allText(doc);
    for (const need of b.requiredText) {
      if (!text.includes(need)) add('error', 'required_text_missing', `规范里要求出现的「${need}」，画布的提示词里没有写。`);
    }
    for (const bad of b.forbidden) {
      if (text.includes(bad)) add('error', 'forbidden_word_present', `规范里禁止的「${bad}」出现在了提示词里。`);
    }
    if (b.deliverables.length) {
      const outs = mediaNodes(doc).filter((n) => String(n.url || '').trim()).length;
      if (outs < b.deliverables.length) {
        add('warn', 'deliverables_short', `要求交付 ${b.deliverables.length} 件，当前画布上只有 ${outs} 件出了结果。`);
      }
    }
  }
  return { ok: issues.every((i) => i.level !== 'error'), issues };
}

/**
 * 带尺寸核验的巡检：对已出图的节点读真实文件头，和规范里的比例对一遍。
 * 读不到尺寸只记 info，不误判成失败。
 */
/**
 * 读一张画布结果的真实尺寸。
 * 画布上的地址多是 `/api/ws/file?path=…`（相对路径），而 verifyImageDimensions 只认 data: 和绝对 http，
 * 直接交给它永远是"核不了"——所以先按工作区相对路径直读文件头，读不到再走远端核验。
 */
export function localPathFromUrl(wsRoot, url) {
  const m = /[?&]path=([^&]+)/.exec(String(url || ''));
  if (!m || !wsRoot) return '';
  try {
    const root = path.resolve(String(wsRoot));
    const abs = path.resolve(root, decodeURIComponent(m[1]).replace(/\\/g, '/'));
    return abs.startsWith(root + path.sep) ? abs : '';
  } catch { return ''; }
}

export function dimensionsFromFile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size <= 0) return null;
    const buf = fs.readFileSync(file).subarray(0, 262144);
    const d = readImageDimensions(buf);
    return d?.width && d?.height ? { width: d.width, height: d.height } : null;
  } catch { return null; }
}

async function dimsOf(node, wsRoot, verify) {
  const url = String(node.url || '');
  const file = localPathFromUrl(wsRoot, url);
  if (file) {
    const local = dimensionsFromFile(file);
    if (local) return local;
  }
  const v = await verify(url, String(node.size || ''), '');
  return v?.width && v?.height ? { width: v.width, height: v.height } : null;
}

export async function auditCanvas(doc, { brief, wsRoot = '', verify = verifyImageDimensions } = {}) {
  const base = auditCanvasDoc(doc, { brief });
  const issues = [...base.issues];
  const b = normalizeBrief(brief);
  // 全景模板硬要求 2:1；其余按规范，没写就不猜
  for (const n of mediaNodes(doc)) {
    const want = n.template === 'panorama' ? 2 : (b.ratios[n.kind] || b.ratios[n.id] || 0);
    if (!want || !String(n.url || '').trim()) continue;
    const ratio = `${want}:1`;
    try {
      const dims = await dimsOf(n, wsRoot, verify);
      if (!dims) {
        issues.push({ level: 'info', code: 'dimension_unverified', nodeId: n.id, message: `${label(n)} 的尺寸暂时核不了（文件可能还没落盘）。` });
        continue;
      }
      const actual = dims.width / dims.height;
      if (Math.abs(actual / want - 1) > 0.01) {
        issues.push({ level: 'error', code: 'ratio_mismatch', nodeId: n.id,
          message: `${label(n)} 比例不对：要求 ${ratio}，实际 ${dims.width}×${dims.height}（${actual.toFixed(3)}）。` });
      }
    } catch {
      issues.push({ level: 'info', code: 'dimension_unverified', nodeId: n.id, message: `${label(n)} 的尺寸暂时核不了（文件可能还没落盘）。` });
    }
  }
  return { ok: issues.every((i) => i.level !== 'error'), issues };
}

export function formatAudit(result) {
  const issues = result?.issues || [];
  if (!issues.length) return '画布巡检通过：没有发现偏离。';
  const mark = { error: '❌', warn: '⚠️', info: 'ℹ️' };
  return [`画布巡检：${issues.filter((i) => i.level === 'error').length} 个问题、${issues.filter((i) => i.level === 'warn').length} 个提醒。`,
    ...issues.map((i) => `${mark[i.level] || '·'} [${i.code}] ${i.message}`)].join('\n');
}
