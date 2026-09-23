export const SKINS = [
  { id: 'chibi', label: 'Q版', detail: '表情立绘' },
  { id: 'doll', label: '盲盒公仔', detail: '安静陪伴' },
  { id: 'puppet', label: 'Q版 · 轻动', detail: '轻轻呼吸' },
  { id: 'doll-puppet', label: '公仔 · 轻动', detail: '轻轻呼吸' },
];
export const normalizeSkin = value => SKINS.some(s => s.id === value) ? value : 'chibi';
export const normalizeMode = value => value === 'roam' ? 'roam' : 'corner';
export function imageForSkin(skin, frame = 'open') {
  // Doll poses are distinct illustrations, not interchangeable animation frames.
  if (skin === 'doll' || skin === 'doll-puppet') return '/static/branding/doll-01-256.png?v=8';
  const safeFrame = ['open', 'closed', 'happy', 'focused', 'thinking', 'sleepy', 'wave'].includes(frame) ? frame : 'open';
  return `/static/branding/xiaoyu-${safeFrame}-t.png?v=8`;
}
export function clampPosition(point, viewport) {
  return {
    x: Math.max(12, Math.min(Math.max(12, viewport.width - 108), Number.isFinite(point.x) ? point.x : 12)),
    y: Math.max(12, Math.min(Math.max(12, viewport.height - 212), Number.isFinite(point.y) ? point.y : 12)),
  };
}
export function panelPosition(point, viewport, height) {
  const width = Math.min(296, viewport.width - 24);
  const maxHeight = Math.min(height, viewport.height - 24);
  const above = point.y - maxHeight - 12;
  return {
    width, maxHeight,
    left: Math.max(12, Math.min(viewport.width - width - 12, point.x + 96 - width)),
    top: Math.max(12, Math.min(viewport.height - maxHeight - 12, above >= 12 ? above : point.y + 112)),
  };
}
export const movedEnough = (start, now) => Math.hypot(start.x - now.x, start.y - now.y) > 6;
