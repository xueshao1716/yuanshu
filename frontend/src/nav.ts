export const ROUTE_LABELS = {
  chat: '对话',
  board: '工作台',
  review: '改动验收',
  team: '天团协作',
  lingxi: '灵感',
  workshop: '创作',
  canvas: '对比台',
  story: '连续创作',
  models: '模型',
  assets: '资产',
  tasks: '任务',
  downloads: '下载中心',
  apps: '知识',
  engine: '能力',
  themes: '主题',
  sessiondb: '会话库',
  mcp: 'MCP',
  system: '系统',
  soul: '灵魂培养',
  grants: '授权中心',
  tv: '影视',
} as const

// 桌面主栏只放用户每天会找的工作入口；引擎从“更多”提升为一等入口。
// 改动验收不再是独立主栏项：它的板块与工作台重复（近期工作说明、子智能体记录），
// 已并入工作台作为页内视图；#/review 仍保留为深链别名。
// 连续创作同理：它是创作的一条产线，已并入创作作为页内视图；#/story 保留为深链别名。
// 附带修复：手机「更多」菜单里从来没有连续创作入口，并入创作后手机端才到得了。
export const RAIL_PRIMARY = ['chat', 'board', 'workshop', 'assets', 'tasks', 'engine'] as const

// 2026-10 功能板块整理：相近页面并入同一板块，旧深链保留为别名（见 RAIL_OWNER）。
//   资产 ⊃ 下载记录；工作台 ⊃ 改动验收 / 天团 / 会话库；知识 ⊃ 灵感；能力 ⊃ MCP；创作 ⊃ 连续创作 / 画布。
//   沙箱 / 超维模式只在授权中心（本会话执行权限）；系统页不再重复放一份。
export const RAIL_MORE = ['soul', 'grants', 'tv', 'apps', 'system'] as const

// 别名路由 → 它所属的导航板块；导航高亮、手机「更多」激活态都按板块算。
export const RAIL_OWNER: Record<string, string> = {
  review: 'board', team: 'board', sessiondb: 'board',
  story: 'workshop', canvas: 'workshop',
  downloads: 'assets',
  lingxi: 'apps',
  mcp: 'engine',
}
export const railOwner = (route: string): string => RAIL_OWNER[route] ?? route
