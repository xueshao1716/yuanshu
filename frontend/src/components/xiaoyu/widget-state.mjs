import { portraitFor } from './companion-state.mjs';
export const SKINS = [
  { id: 'portrait', label: '写真人像', detail: '冷白 · 长发' },
];
export const normalizeSkin = _value => 'portrait';
export const normalizeMode = value => value === 'roam' ? 'roam' : 'corner';
export const canRoam = _skin => false;
export function imageForSkin(skin, frame = 'open') {
  return portraitFor('neutral').src;
}
export function clampPosition(point, viewport) {
  return {
    x: Math.max(12, Math.min(Math.max(12, viewport.width - 108), Number.isFinite(point.x) ? point.x : 12)),
    y: Math.max(12, Math.min(Math.max(12, viewport.height - 212), Number.isFinite(point.y) ? point.y : 12)),
  };
}
// Compact restore button bounds: keep it above the mobile composer/navigation
// while leaving a comfortable edge gutter on desktop.
export function clampFloatingPosition(point, viewport) {
  const width = 72;
  const height = 72;
  const safeBottom = viewport.width <= 600 ? 104 : 28;
  return {
    x: Math.max(12, Math.min(Math.max(12, viewport.width - width - 12), Number.isFinite(point.x) ? point.x : viewport.width - width - 20)),
    y: Math.max(12, Math.min(Math.max(12, viewport.height - height - safeBottom), Number.isFinite(point.y) ? point.y : viewport.height - height - safeBottom)),
  };
}
export function collapsedPosition(viewport) {
  return clampFloatingPosition({ x: viewport.width - 84, y: viewport.height - 132 }, viewport);
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
