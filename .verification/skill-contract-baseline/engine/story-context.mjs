// engine/story-context.mjs —— 全剧上下文（"故事到现在为止"）
//
// 对照 Laper 时发现的第二个真缺口：它主打 **200K 全剧本上下文**，AI 读整个剧本再给建议；
// 而元枢这边 `story-store.mergeBeatContext` 只带**继承链上的前 3 段**（每段截 1.2 万字）。
// 后果很具体：写到第 8 段时，第 2 段发生过什么模型看不见——不在继承链上就丢了，
// 于是"人物突然不认人""同一个道具换了个颜色"。
//
// 这一层负责把"全剧至今"压成一份有上限的材料。三条原则：
// 1. **有上限**（默认 2 万字，可用 STORY_CONTEXT_CHARS 配）。不设上限就是把成本交给运气；
// 2. **先保证"发生了什么"，再给正文**。已生成正文按段截断，场摘要永远保留——
//    模型真正需要的是事件与状态，不是文采；
// 3. **在提示词里说清这是"已发生的既成事实"**，不是让它续写的地方。
import { normalizeBeatInputs } from './story-store.mjs';

export const DEFAULT_CONTEXT_CHARS = 20000;
export function contextBudget(env = process.env) {
  const raw = Number(env?.STORY_CONTEXT_CHARS);
  return Number.isFinite(raw) && raw >= 2000 && raw <= 200000 ? Math.round(raw) : DEFAULT_CONTEXT_CHARS;
}

function clip(text, max) {
  const s = String(text || '').trim();
  if (!s) return '';
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

// 某一段"已经生成出来的正文"（最后一次成功的那一版；novel 类才会是长文）
export function latestProse(scene, beatId, kind) {
  if (kind && kind !== 'novel') return '';
  const run = [...(scene?.outputs || [])].reverse()
    .find(r => r?.beatId === beatId && ['succeeded', 'degraded'].includes(r.status) && r.outputAssets?.length);
  if (!run) return '';
  return (run.outputAssets || []).filter(a => a.type === 'text' && a.text).map(a => String(a.text)).join('\n').trim();
}

// 组装"全剧至今"。返回 { text, chars, scenes, proseBeats, truncated }，
// truncated 表示因为预算被砍过——**要如实回给界面**，别让人以为模型看到了全部。
export function buildStorySoFar(project, { maxChars = DEFAULT_CONTEXT_CHARS, excludeBeatId = '', perProseChars = 1200 } = {}) {
  const blocks = [];
  let truncated = false;
  let proseBeats = 0;
  const scenes = [];

  for (const [i, scene] of (project?.scenes || []).entries()) {
    const head = `### 第 ${i + 1} 场 · ${String(scene?.title || '未命名')}${scene?.slug?.location ? `（${scene.slug.location}）` : ''}`;
    const parts = [head];
    if (scene?.summary) parts.push(`摘要：${clip(scene.summary, 400)}`);
    const beatLines = [];
    for (const [j, beat] of (scene?.beats || []).entries()) {
      const action = clip(beat?.action || beat?.prompt || '', 160);
      const dialogue = clip(beat?.dialogue || '', 240);
      const prose = beat?.id === excludeBeatId ? '' : latestProse(scene, beat?.id, beat?.kind);
      if (prose) proseBeats += 1;
      const bits = [`${j + 1}.${action ? ` ${action}` : ''}`];
      if (dialogue) bits.push(`   台词：${dialogue}`);
      if (prose) bits.push(`   已写正文：${clip(prose, perProseChars)}`);
      if (action || dialogue || prose) beatLines.push(bits.join('\n'));
    }
    if (beatLines.length) parts.push(beatLines.join('\n'));
    const materials = [...new Set((scene?.beats || []).flatMap(b => normalizeBeatInputs(b.inputs).map(m => m.name || m.type)))]
      .filter(Boolean).slice(0, 6);
    if (materials.length) parts.push(`挂载素材：${materials.join('、')}`);
    scenes.push(head);
    blocks.push(parts.join('\n'));
  }

  const header = '## 全剧至今（已发生的既成事实，不要与之矛盾）\n以下是为了让你接得上前面：**只保持一致，不要复述、不要重写**。';
  let text = blocks.length ? `${header}\n\n${blocks.join('\n\n')}` : '';
  if (text.length > maxChars) {
    // 砍掉的是最早的部分（最久远的情节对"接着写"最不重要），并如实标记
    const tail = text.slice(-maxChars);
    const cut = tail.indexOf('\n### ');
    text = `${header}\n（更早的内容因为长度上限被省略了）\n${cut > 0 ? tail.slice(cut) : tail}`;
    truncated = true;
  }
  return { text, chars: text.length, scenes: scenes.length, proseBeats, truncated };
}
