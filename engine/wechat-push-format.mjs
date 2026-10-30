// engine/wechat-push-format.mjs —— 推送到微信的排版（2026-10-24）
//
// 背景：聊天回复走 reply() 已经有 markdown → 微信文本的转换；但**主动推送**（任务完成、交付通知）
// 以前是把 notifier 的 body 硬截 600 字直接发——长文被腰斩、没有结构，手机上很难读。
// 这里把推送整理成一张"卡片"：标题行 + 3–5 条要点 + 时间脚注，整体控制在 400 字内。
import { stripMarkdownForWechat } from './wechat-ilink.mjs';

const MAX_ITEMS = 5;
const MAX_ITEM_CHARS = 56;
const MAX_TOTAL = 420;

function clip(text, n) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** 从正文里抽要点：优先列表项 / 小标题，其次按句子切 */
export function extractPoints(body, limit = MAX_ITEMS) {
  const raw = stripMarkdownForWechat(String(body || '').trim());
  if (!raw) return [];
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const bullets = lines.filter((l) => /^[•☐☑▸▪①②③④⑤⑥⑦⑧⑨⑩┃]/.test(l));
  const source = bullets.length ? bullets : lines;
  const out = [];
  for (const line of source) {
    const cleaned = line.replace(/^[•☐☑▸▪┃\-*+]\s*/, '').replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, '').trim();
    if (!cleaned || cleaned.length < 2) continue;
    if (out.length >= limit) break;
    out.push(clip(cleaned, MAX_ITEM_CHARS));
  }
  if (out.length) return out;
  // 没有结构：按句子切前两条
  const sentences = raw.split(/(?<=[。！？!?])/).map((s) => s.trim()).filter(Boolean);
  return sentences.slice(0, 2).map((s) => clip(s, MAX_ITEM_CHARS * 2));
}

const KIND_ICON = { task: '🗓', agent: '💬', cultivation: '🌱', system: '⚙️', delivery: '📦' };

/** 把一条通知整理成手机上能读的卡片 */
export function formatWechatPush({ title = '', body = '', kind = 'agent', now = new Date(), sender = '', summary = '', facts = [] } = {}) {
  // 2026-10-30 伙伴原话：抬头别写「元枢」，结尾别写「详情在元枢」，要说清什么事。
  // sender = 人设名（小语）；summary = 一句话说明这条是什么事。
  const head = clip(stripMarkdownForWechat(String(title || '').trim()) || String(sender || '').trim() || '元枢', 40);
  const rawBody = stripMarkdownForWechat(String(body || '').trim());
  const bodyLines = rawBody.split(/\n/).map((x) => x.trim()).filter(Boolean).slice(0, 3);
  // 2026-10-30：通知类原样排她的正文；任务/交付类必须用清理过的要点，
  // 否则 stripMarkdown 已经把 "- " 变成 "• "，再加前缀就成了「• •」。
  const isNotice = ['companion', 'night', 'morning'].includes(kind);
  const points = isNotice ? (bodyLines.length ? bodyLines : extractPoints(body)) : extractPoints(body);
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const icon = KIND_ICON[kind] || '💬';
  const label = sender && !head.includes(sender) ? `${head}｜${sender}` : head;
  const lines = [`${icon} ${label}`, '━━━━━━━━'];
  if (points.length) {
    // 2026-10-30：只有一句话时不加项目符号——主动推送是「她说话」，不是清单
    // 主动推送是「她说话」：正文原样排，不加 •；任务/交付类才用要点符号
    const single = isNotice;
    for (let i = 0; i < points.length; i += 1) {
      if (i > 0 && single) lines.push('');
      lines.push(single ? points[i] : `• ${points[i]}`);
    }
  } else {
    lines.push(clip(String(body || ''), 120) || '（无正文）');
  }
  // 2026-10-30：数据从"一行挤三个"改成"一条一行"——手机上更好扫读
  const factLines = (Array.isArray(facts) ? facts : []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 4);
  if (factLines.length) {
    lines.push('');
    for (const f of factLines) lines.push(`· ${clip(f, 40)}`);
  }
  if (factLines.length) lines.push('');
  lines.push(summary ? `—— ${time} · ${clip(String(summary), 30)}` : `—— ${time}`);
  let text = lines.join('\n');
  if (text.length > MAX_TOTAL) text = text.slice(0, MAX_TOTAL - 1) + '…';
  return text;
}
