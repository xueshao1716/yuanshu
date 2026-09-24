const kinds = new Set('topAppBar bottomNav navRail tabs searchBar button iconButton fab extendedFab splitButton fabMenu toolbar chip card listItem box dialog snackbar textField select switch checkbox radio slider text image camera map divider badge loadingIndicator linearProgress circularProgress'.split(' '));
const variants = new Set(['filled','tonal','elevated','outlined','text']);
export function designError(message, statusCode = 400) { return Object.assign(new Error(message), {statusCode}); }
const requireValue = (value, message) => { if (!value) throw designError(message); };

export function validateDocument(doc) {
  requireValue(doc && Array.isArray(doc.frames) && Array.isArray(doc.groups), '画布格式错误');
  requireValue(doc.frames.length > 0 && doc.groups.length > 0, '画布不能为空');
  requireValue(Buffer.byteLength(JSON.stringify(doc)) <= 150_000, '画布过大，请拆成多个作品');
  requireValue(doc.frames.length <= 20 && doc.groups.length <= 300, '画布组件过多');
  requireValue(doc.platform === undefined || ['android','web'].includes(doc.platform), '画布平台无效');
  const ids = new Set(), frameIds = new Set(doc.frames.map(f=>f?.id));
  function id(value) {
    requireValue(typeof value === 'string' && value.length > 0 && value.length <= 100, '画布标识无效');
    requireValue(!ids.has(value), '画布标识重复'); ids.add(value);
  }
  for (const f of doc.frames) {
    requireValue(f && typeof f.name === 'string' && Number.isFinite(f.x) && Number.isFinite(f.y), '画布屏幕格式错误');
    id(f.id);
    requireValue(f.note === undefined || typeof f.note === 'string', '画布屏幕备注错误');
    requireValue(f.place === undefined || ['top','center','bottom','spread'].includes(f.place), '画布屏幕排布错误');
    for (const size of ['w','h']) requireValue(f[size] === undefined || (Number.isFinite(f[size]) && f[size] > 0 && f[size] <= 10000), '画布尺寸错误');
  }
  for (const g of doc.groups) {
    requireValue(g && Number.isFinite(g.x) && Number.isFinite(g.y) && ['x','y'].includes(g.axis) && Array.isArray(g.items) && g.items.length > 0 && g.items.length <= 100, '画布组件组格式错误');
    id(g.id);
    for (const item of g.items) {
      requireValue(item && kinds.has(item.kind) && typeof item.label === 'string' && (item.icon === null || typeof item.icon === 'string') && variants.has(item.variant), '画布组件格式错误：每个 item 都需要合法 kind、字符串 label、icon（无图标填 null）和 variant（默认 filled）');
      id(item.id);
      requireValue(item.tabs === undefined || (Array.isArray(item.tabs) && item.tabs.every(t=>t && typeof t.label === 'string' && (t.icon === undefined || t.icon === null || typeof t.icon === 'string'))), '画布标签格式错误');
      for (const field of ['supporting','note']) requireValue(item[field] === undefined || typeof item[field] === 'string', '画布组件文字错误');
      requireValue(item.selected === undefined || Number.isFinite(item.selected), '画布选项错误');
      requireValue(item.corners === undefined || (item.corners && ['tl','tr','bl','br'].every(k=>Number.isFinite(item.corners[k]))), '画布圆角错误');
    }
  }
  function walk(value, depth = 0) {
    requireValue(depth < 20, '画布嵌套过深');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      requireValue(!['__proto__','constructor','prototype'].includes(key), '画布字段无效');
      if (key === 'src' && child) requireValue(typeof child === 'string' && /^https:\/\/[^\s]+$/i.test(child), '素材只支持 HTTPS 图片地址');
      if (key === 'to') requireValue(child === 'back' || frameIds.has(child), '画布跳转目标不存在');
      if (key === 'swipe') for (const target of Object.values(child || {})) requireValue(frameIds.has(target), '画布跳转目标不存在');
      walk(child, depth + 1);
    }
  }
  walk(doc);
  return structuredClone(doc);
}

export function mergeGroup(base, groupId, answer) {
  requireValue(base.groups.some(g=>g.id === groupId), '组件不存在');
  requireValue(answer?.group?.id === groupId, '模型返回的组件与选定组件不符');
  return validateDocument({...base, groups:base.groups.map(g=>g.id === groupId ? answer.group : g)});
}

export function parseDesignReply(text) {
  if (typeof text !== 'string' || !text.trim()) throw designError('模型未返回设计内容，请重试；原版本已保留', 502);
  const raw = text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  try { return JSON.parse(raw); } catch { throw designError('模型没有返回完整设计 JSON，未保存无效版本', 502); }
}
