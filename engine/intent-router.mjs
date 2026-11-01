// ===== intent-router.mjs —— 一句话打开页面（2026-11-01）=====
//
// 伙伴提的：应该在对话里就能"打开任务清单"，而不是自己找左下角。
// 这里把「打开/看/列出 + 名词」映射成前端路由，由服务端在处理这轮时发一个 nav 事件，
// 前端收到就切页。规则优先（不花钱），判断不了就交给原来的对话流程，不打断。
import { ROUTE_LABELS } from "./route-labels.mjs";

/** 名词 → 路由（按具体到泛化排序，先匹配长的）。 */
export const TARGETS = [
  { words: ["定时任务", "任务清单", "任务列表", "待办", "任务"], route: "tasks" },
  { words: ["事务台", "路由器", "路由判断", "待你拍板", "交付门", "脑区"], route: "gateway" },
  { words: ["插件商店", "插件中心", "插件"], route: "plugins" },
  { words: ["授权中心", "权限", "授权"], route: "grants" },
  { words: ["自动补丁", "补丁"], route: "autopatch" },
  { words: ["灵魂培养", "培养", "人格"], route: "soul" },
  { words: ["天团", "协作"], route: "team" },
  { words: ["改动验收", "验收", "diff"], route: "review" },
  { words: ["工作台", "看板", "驾驶舱"], route: "board" },
  { words: ["创作", "作品"], route: "workshop" },
  { words: ["资产", "下载记录", "下载中心", "生成的图", "生成物"], route: "assets" },
  { words: ["能力", "引擎", "技能"], route: "engine" },
  { words: ["模型", "换模型"], route: "models" },
  { words: ["知识", "灵感"], route: "apps" },
  { words: ["会话库", "历史会话", "会话管理"], route: "sessiondb" },
  { words: ["MCP", "mcp"], route: "mcp" },
  { words: ["主题", "外观"], route: "themes" },
  { words: ["系统", "设置"], route: "system" },
  { words: ["影视", "视频"], route: "tv" },
  { words: ["对比台", "画布"], route: "canvas" },
  { words: ["连续创作"], route: "story" },
  { words: ["对话", "聊天"], route: "chat" },
];

/** 打开类动词：有这些才算"要我做个动作"。 */
const OPEN_VERB = /(打开|开一下|进到|进入|跳到|切到|切去|回到|去看看|看一下|看看|瞅瞅|列一下|列出来|列出|显示|展示|调出|调一下)/;

/**
 * 解析一句话里的"打开某页"意图。
 * @returns {{route:string, label:string, matched:string} | null}
 */
export function parseOpenIntent(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 120) return null;
  // 必须先有打开类动词，避免把"任务做完了"当成导航
  if (!OPEN_VERB.test(t)) return null;
  // 先匹配更长的词
  const flat = [];
  for (const target of TARGETS) for (const w of target.words) flat.push({ word: w, route: target.route });
  flat.sort((a, b) => b.word.length - a.word.length);
  for (const item of flat) {
    if (!t.includes(item.word)) continue;
    return { route: item.route, label: ROUTE_LABELS[item.route] || item.route, matched: item.word };
  }
  return null;
}

/** 给前端的导航事件体。 */
export function navPayload(intent) {
  if (!intent) return null;
  return { route: intent.route, label: intent.label, text: `正在打开${intent.label}` };
}
