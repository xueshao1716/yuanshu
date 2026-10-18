// engine/canvas.mjs —— 无限画布的**服务端**存储 + 模型工具
//
// 2026-10-18 伙伴：「小语能操作画布」。此前画布只存在浏览器 localStorage，
// 模型完全碰不到——它没法"基于这张产品图建三个场景的节点链"。
//
// 分工：
//   · 前端仍掌握全部交互逻辑（frontend/src/lib/canvas-nodes.mjs）；
//   · 服务端这里只做**校验 + 落盘 + 给模型的操作接口**，规则是前端的严格子集；
//   · 两边规则若有出入，以这里为准（服务端不许写出前端会拒绝的文档）。
//
// 存储：记忆/运行时/画布.json，原子写，带 revision 递增。

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from './atomic-io.mjs';

export const CANVAS_FILE = path.join('记忆', '运行时', '画布.json');
export const CANVAS_KINDS = ['text', 'prompt', 'config', 'image'];
export const CANVAS_MAX = { nodes: 400, edges: 1200, text: 4000, title: 80, id: 64 };
const NODE_KEYS = ['id', 'kind', 'x', 'y', 'w', 'h', 'title', 'text', 'template', 'model', 'size', 'provider', 'modelId', 'status', 'url', 'error', 'ref'];
const DEFAULT_SIZE = { text: [280, 160], prompt: [300, 176], config: [264, 168], image: [300, 320] };

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v, max) => String(v ?? '').slice(0, max);

function canvasPath(wsRoot) { return path.join(wsRoot, CANVAS_FILE) }

export function emptyCanvas() {
  return { v: 1, revision: 0, updatedAt: null, nodes: [], edges: [], view: { x: 0, y: 0, z: 1 } };
}

/** 规范化一份文档：未知类型/重复 id/悬空连线一律丢弃，并给出原因。 */
export function normalizeCanvasDoc(raw) {
  const errors = [];
  const src = raw && typeof raw === 'object' ? raw : {};
  const nodes = [];
  const seen = new Set();
  for (const item of Array.isArray(src.nodes) ? src.nodes.slice(0, CANVAS_MAX.nodes) : []) {
    if (!item || typeof item !== 'object') { errors.push('跳过非对象节点'); continue }
    const kind = String(item.kind || '');
    if (!CANVAS_KINDS.includes(kind)) { errors.push(`跳过未知节点类型：${kind || '(空)'}`); continue }
    const id = str(item.id, CANVAS_MAX.id).trim();
    if (!id || seen.has(id)) { errors.push('跳过缺少 id 或 id 重复的节点'); continue }
    seen.add(id);
    const [dw, dh] = DEFAULT_SIZE[kind];
    const n = {};
    for (const k of NODE_KEYS) if (item[k] !== undefined) n[k] = item[k];
    Object.assign(n, {
      id, kind,
      x: num(item.x), y: num(item.y),
      w: Math.max(80, num(item.w, dw)), h: Math.max(60, num(item.h, dh)),
      title: str(item.title || kind, CANVAS_MAX.title),
      text: str(item.text, CANVAS_MAX.text),
      template: item.template === 'panorama' ? 'panorama' : 'plain',
      model: str(item.model, 120), size: str(item.size, 40),
      provider: str(item.provider, 60), modelId: str(item.modelId, 120),
      status: ['idle', 'running', 'done', 'error'].includes(item.status) ? item.status : 'idle',
      url: str(item.url, 2000), error: str(item.error, 400), ref: str(item.ref, 2000),
    });
    nodes.push(n);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = [];
  const pair = new Set();
  const single = new Set();
  for (const e of Array.isArray(src.edges) ? src.edges.slice(0, CANVAS_MAX.edges) : []) {
    const from = byId.get(str(e?.from, CANVAS_MAX.id));
    const to = byId.get(str(e?.to, CANVAS_MAX.id));
    if (!from || !to) { errors.push('跳过悬空连线'); continue }
    if (from.id === to.id) { errors.push('跳过自连'); continue }
    if (to.kind !== 'image') { errors.push('只有图片节点能接收连线'); continue }
    if (from.kind === 'text') { errors.push('文本节点没有输出'); continue }
    const key = `${from.id}->${to.id}`;
    if (pair.has(key)) { errors.push('跳过重复连线'); continue }
    pair.add(key);
    // 提示词/配置每个目标只留一条（新的优先）
    if (from.kind !== 'image') {
      const sk = `${from.kind}->${to.id}`;
      if (single.has(sk)) { errors.push(`跳过重复的 ${from.kind} 输入`); continue }
      single.add(sk);
    }
    edges.push({ id: str(e.id, 40) || `e${edges.length + 1}`, from: from.id, to: to.id, kind: from.kind });
  }
  const view = { x: num(src.view?.x), y: num(src.view?.y), z: Math.min(2.5, Math.max(0.2, num(src.view?.z, 1))) };
  return { doc: { v: 1, revision: Math.max(0, Math.floor(num(src.revision))), updatedAt: src.updatedAt || null, nodes, edges, view }, errors };
}

export function readCanvasDoc(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(canvasPath(wsRoot), 'utf8'));
    const { doc } = normalizeCanvasDoc(raw);
    return doc;
  } catch { return emptyCanvas() }
}

export function writeCanvasDoc(wsRoot, raw) {
  const { doc, errors } = normalizeCanvasDoc(raw);
  const next = { ...doc, revision: (readCanvasDoc(wsRoot).revision || 0) + 1, updatedAt: new Date().toISOString() };
  const file = canvasPath(wsRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteJson(file, next);
  return { ok: true, doc: next, errors };
}

// ── 模型侧操作 ─────────────────────────────────────────────────────
export const CANVAS_TOOL_SCHEMA = {
  type: 'function',
  function: {
    name: 'canvas',
    description: '读写无限画布。agent 可以直接为用户搭好创作链路：建提示词/配置/图片节点、把它们连起来、设置模型和提示词。用户在画布页能看到你改的结果。用户说「基于这张图做三个场景」时，就自己建节点连线。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'add_node', 'update_node', 'connect', 'disconnect', 'remove_node', 'clear'] },
        nodeId: { type: 'string', description: 'update_node / remove_node / disconnect 用' },
        edgeId: { type: 'string', description: 'disconnect 用' },
        kind: { type: 'string', enum: ['text', 'prompt', 'config', 'image'], description: 'add_node 用' },
        text: { type: 'string', description: '节点提示词/文本' },
        title: { type: 'string', description: '节点标题' },
        provider: { type: 'string', description: '出图服务商（配置节点或图片节点）' },
        modelId: { type: 'string', description: '出图模型 id' },
        size: { type: 'string', description: '尺寸，如 1024x1024' },
        template: { type: 'string', enum: ['plain', 'panorama'] },
        from: { type: 'string', description: 'connect 的起点节点 id（提示词/配置/图片）' },
        to: { type: 'string', description: 'connect 的终点图片节点 id' },
      },
      required: ['action'],
    },
  },
};

export function canvasSummary(doc) {
  const nodes = doc.nodes || [];
  const edges = doc.edges || [];
  const lines = nodes.slice(0, 40).map((n) => {
    const bits = [`[${n.id}] ${n.kind}`];
    if (n.title && n.title !== n.kind) bits.push(n.title);
    if (n.kind === 'image' && (n.provider || n.modelId)) bits.push(`${n.provider}/${n.modelId}`);
    if (n.status !== 'idle') bits.push(n.status);
    if (n.text) bits.push(`"${n.text.slice(0, 40)}"`);
    return `- ${bits.join(' · ')}`;
  });
  const links = edges.slice(0, 60).map((e) => `- ${e.from} → ${e.to}（${e.kind}）`);
  return [
    `画布 revision ${doc.revision}，节点 ${nodes.length} 个、连线 ${edges.length} 条。`,
    nodes.length ? '节点：' : '（画布是空的）',
    ...lines,
    links.length ? '连线：' : '',
    ...links,
  ].filter(Boolean).join('\n');
}

function skillBump(doc, mutate) {
  const next = JSON.parse(JSON.stringify(doc));
  const msg = mutate(next);
  return { next, msg };
}

export function canvasExtraExecutors(wsRoot) {
  return {
    canvas: (args = {}) => {
      const action = String(args.action || 'read');
      try {
        const doc = readCanvasDoc(wsRoot);
        if (action === 'read') return { text: canvasSummary(doc), isError: false };

        if (action === 'clear') {
          const r = writeCanvasDoc(wsRoot, { ...emptyCanvas(), revision: doc.revision });
          return { text: `已清空画布。\n${canvasSummary(r.doc)}`, isError: false };
        }

        if (action === 'add_node') {
          const kind = String(args.kind || '');
          if (!CANVAS_KINDS.includes(kind)) return { text: 'kind 只能是 text/prompt/config/image', isError: true };
          if (doc.nodes.length >= CANVAS_MAX.nodes) return { text: '画布节点已到上限', isError: true };
          const id = `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
          const [w, h] = DEFAULT_SIZE[kind];
          const col = doc.nodes.length % 4, row = Math.floor(doc.nodes.length / 4);
          const node = {
            id, kind, x: 96 + col * 340, y: 96 + row * 380, w, h,
            title: str(args.title || kind, CANVAS_MAX.title),
            text: str(args.text, CANVAS_MAX.text),
            template: args.template === 'panorama' ? 'panorama' : 'plain',
            model: '', size: str(args.size, 40),
            provider: str(args.provider, 60), modelId: str(args.modelId, 120),
            status: 'idle', url: '', error: '', ref: '',
          };
          const r = writeCanvasDoc(wsRoot, { ...doc, nodes: [...doc.nodes, node] });
          return { text: `已新建 ${kind} 节点 ${id}。\n${canvasSummary(r.doc)}`, isError: false };
        }

        if (action === 'update_node') {
          const id = String(args.nodeId || '');
          const hit = doc.nodes.find((n) => n.id === id);
          if (!hit) return { text: `画布上没有节点 ${id}；先 read 看有哪些`, isError: true };
          const patch = {};
          for (const k of ['text', 'title', 'provider', 'modelId', 'size', 'template']) {
            if (args[k] !== undefined) patch[k] = args[k];
          }
          const nodes = doc.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n));
          const r = writeCanvasDoc(wsRoot, { ...doc, nodes });
          return { text: `已更新节点 ${id}。\n${canvasSummary(r.doc)}`, isError: false };
        }

        if (action === 'connect') {
          const from = doc.nodes.find((n) => n.id === String(args.from || ''));
          const to = doc.nodes.find((n) => n.id === String(args.to || ''));
          if (!from || !to) return { text: 'connect 需要有效的 from/to 节点 id（先 read）', isError: true };
          if (from.id === to.id) return { text: '不能连自己', isError: true };
          if (to.kind !== 'image') return { text: '只有图片节点能接收连线', isError: true };
          if (from.kind === 'text') return { text: '文本节点没有输出，请改用提示词节点', isError: true };
          const dup = doc.edges.some((e) => e.from === from.id && e.to === to.id);
          if (dup) return { text: '这条连线已存在', isError: false };
          const edges = from.kind === 'image'
            ? [...doc.edges, { id: `e${Date.now().toString(36)}`, from: from.id, to: to.id, kind: 'image' }]
            : [...doc.edges.filter((e) => !(e.to === to.id && e.kind === from.kind)), { id: `e${Date.now().toString(36)}`, from: from.id, to: to.id, kind: from.kind }];
          const r = writeCanvasDoc(wsRoot, { ...doc, edges });
          return { text: `已连接 ${from.id} → ${to.id}（${from.kind}）。\n${canvasSummary(r.doc)}`, isError: false };
        }

        if (action === 'disconnect') {
          const edgeId = String(args.edgeId || '');
          const edges = edgeId
            ? doc.edges.filter((e) => e.id !== edgeId)
            : doc.edges.filter((e) => !(e.from === String(args.from || '') && e.to === String(args.to || '')));
          if (edges.length === doc.edges.length) return { text: '没找到要断开的连线', isError: true };
          const r = writeCanvasDoc(wsRoot, { ...doc, edges });
          return { text: `已断开。\n${canvasSummary(r.doc)}`, isError: false };
        }

        if (action === 'remove_node') {
          const id = String(args.nodeId || '');
          if (!doc.nodes.some((n) => n.id === id)) return { text: `画布上没有节点 ${id}`, isError: true };
          const r = writeCanvasDoc(wsRoot, {
            ...doc,
            nodes: doc.nodes.filter((n) => n.id !== id),
            edges: doc.edges.filter((e) => e.from !== id && e.to !== id),
          });
          return { text: `已删除节点 ${id}。\n${canvasSummary(r.doc)}`, isError: false };
        }

        return { text: `未知 action：${action}`, isError: true };
      } catch (e) {
        return { text: `画布操作失败：${String(e?.message || e).slice(0, 120)}`, isError: true };
      }
    },
  };
}
