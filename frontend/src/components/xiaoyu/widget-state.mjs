export const SKINS = [
  { id: 'portrait', label: '写真人像', detail: '冷白 · 长发' },
];
export const normalizeSkin = _value => 'portrait';
export const normalizeMode = value => value === 'roam' ? 'roam' : 'corner';
export const canRoam = _skin => false;
export function imageForSkin(skin, frame = 'open') {
  return '/assets/portraits/yuanshu-cutout-v1.webp';
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
