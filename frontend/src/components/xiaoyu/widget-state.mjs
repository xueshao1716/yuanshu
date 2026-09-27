import { portraitFor } from './companion-state.mjs';
export const SKINS = [
  { id: 'portrait', label: '状态立绘', detail: '随当前状态切换姿态' },
  { id: 'wardrobe-jk', label: 'JK 制服', detail: '清爽学院风 · 百褶裙' },
  { id: 'wardrobe-skirt', label: '卡其短裙', detail: '卡其色短裙 · 过膝袜' },
  { id: 'wardrobe-trousers', label: '长裤通勤', detail: '简洁利落 · 日常工作' },
  { id: 'wardrobe-collar', label: '轻熟镂空', detail: '柔和光线 · 轻熟风' },
  { id: 'wardrobe-openai', label: '冷调人像', detail: '冷调棚拍 · 正式感' },
];
export const GALLERIES = [
  { id: 'portrait', label: '元枢状态组', detail: '原有状态立绘 · 随任务与情绪切换' },
  { id: 'portrait-life', label: '生活状态组', detail: '另一套真人衣着与生活姿态' },
];
const SKIN_IMAGES = {
  'wardrobe-jk': '/assets/portraits/yuanshu-wardrobe-jk-v1.png',
  'wardrobe-skirt': '/assets/portraits/yuanshu-wardrobe-skirt-v1.png',
  'wardrobe-trousers': '/assets/portraits/yuanshu-wardrobe-trousers-v1.png',
  'wardrobe-collar': '/assets/portraits/yuanshu-wardrobe-collar-v1.png',
  'wardrobe-openai': '/assets/portraits/yuanshu-wardrobe-openai-v1.png',
};
const LIFE_STATE_IMAGES = {
  working: '/assets/portraits/yuanshu-life-working-v1.webp',
  reading: '/assets/portraits/yuanshu-life-reading-v1.webp',
  resting: '/assets/portraits/yuanshu-life-resting-v1.webp',
  daydreaming: '/assets/portraits/yuanshu-life-daydreaming-v1.webp',
  listening: '/assets/portraits/yuanshu-life-listening-v1.webp',
  responding: '/assets/portraits/yuanshu-life-responding-v1.webp',
  neutral: '/assets/portraits/yuanshu-life-listening-v1.webp',
};
const SKIN_IDS = new Set(SKINS.map(s => s.id));
const GALLERY_IDS = new Set(GALLERIES.map(s => s.id));
export const normalizeSkin = value => {
  if (GALLERY_IDS.has(value)) return value;
  // Migrate the previous fixed-outfit preference to the complete alternate
  // gallery so an upgrade never leaves the companion frozen on one image.
  if (SKIN_IDS.has(value)) return value === 'portrait' ? 'portrait' : 'portrait-life';
  return 'portrait';
};
export const normalizeMode = value => value === 'roam' ? 'roam' : 'corner';
export const canRoam = _skin => false;
export function imageForSkin(skin, action = 'neutral') {
  // Keep direct callers of the legacy helper stable while UI preferences use
  // the gallery migration above.
  if (SKIN_IMAGES[skin]) return SKIN_IMAGES[skin];
  const normalized = normalizeSkin(skin);
  if (normalized === 'portrait-life') return LIFE_STATE_IMAGES[action] || LIFE_STATE_IMAGES.neutral;
  return SKIN_IMAGES[normalized] || portraitFor('neutral').src;
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
