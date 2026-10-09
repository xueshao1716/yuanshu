export const ROUTE_LABELS = {
  chat: '对话',
  board: '工作台',
  review: '改动验收',
  team: '天团协作',
  lingxi: '灵感',
  workshop: '创作',
  canvas: '无限画布',
  story: '连续创作',
  models: '模型',
  assets: '资产',
  tasks: '任务',
  downloads: '下载中心',
  apps: '知识',
  engine: '能力',
  themes: '主题',
  sessiondb: '会话库',
  system: '系统',
  soul: '灵魂培养',
  grants: '授权中心',
} as const

// 桌面主栏只放用户每天会找的工作入口；引擎从“更多”提升为一等入口。
// 改动验收不再是独立主栏项：它的板块与工作台重复（近期工作说明、子智能体记录），
// 已并入工作台作为页内视图；#/review 仍保留为深链别名。
// 连续创作同理：它是创作的一条产线，已并入创作作为页内视图；#/story 保留为深链别名。
// 附带修复：手机「更多」菜单里从来没有连续创作入口，并入创作后手机端才到得了。
export const RAIL_PRIMARY = ['chat', 'board', 'workshop', 'assets', 'tasks', 'engine'] as const

export const RAIL_MORE = ['soul', 'grants', 'lingxi', 'apps', 'sessiondb', 'downloads', 'system'] as const
