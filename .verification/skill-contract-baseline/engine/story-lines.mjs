// engine/story-lines.mjs —— 台词的**稳定身份**与**语义时间轴**
//
// 为什么要有这个文件（学自 hypit 的 Top3 第 1 条）：
// 它的脚本里**没有时间码**，只有语义锚点，真实时间由对齐算出来——所以「改一句台词，
// 时间轴自己重排」。元枢此前是反的：台词是一段自由文本（没有身份）、时长是整段一个
// 人工选的 5/10 秒。于是**改一句台词，后面的镜头全要人肉挪**。
//
// 关键判断：**元枢不需要 WhisperX**。`story-craft.mjs` 已经有语速模型
// （SPEECH：3.5~5 字/秒、标点不计入字数、句内停顿 0.2s、句末 0.45s），
// 从文本就能算出每句多长——零依赖、零模型成本。
//
// 三条设计取舍：
//   1. **身份用「说话人 + 归一化文本」做键，不用行号**：行号在删掉中间一句时整体偏移，
//      一改就全变新 ID，等于没有身份。
//   2. **`beat.dialogue` 仍是唯一真相**，`beat.lines` 只是派生缓存（老项目读时派生，不迁移）。
//   3. **秒数是估计**：一律标注"约"，录制后允许回填真实时长（回填只改数值、不动锚点）。
import crypto from 'node:crypto';
import { SPEECH, speakableChars } from './story-craft.mjs';
import { parseDialogueLines } from './story-screenplay.mjs';

// 归一化：去掉标点与空白——"你挡住了我的视线。" 与 "你挡住了我的视线" 是同一个人同一句，
// 改个句号不该换身份。
const normalize = text => String(text || '').replace(/[\s，。！？、；：""''（）()【】「」『』…—\-·,.!?;:'"()[\]]/g, '');

export function stableLineId(speaker, text) {
  const key = `${normalize(speaker)}\u0000${normalize(text)}`;
  return `ln-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 6)}`;
}

// 台词 → 带稳定 id 的行。同文本复跑 id 不变；删一句不影响其它句的身份（不是按位置编号）。
export function syncLines(beat = {}) {
  const rows = parseDialogueLines(String(beat?.dialogue || '')).filter(r => r.type === 'dialogue' && r.text);
  const lines = rows.map((row, i) => ({
    id: stableLineId(row.speaker, row.text),
    speaker: row.speaker,
    ...(row.paren ? { paren: row.paren } : {}),
    text: row.text,
    // 锚点：语义位置（第几句之后），不是"第几秒"。秒数随时可重算，锚点不会漂。
    anchor: i,
  }));
  return { lines, changed: JSON.stringify(beat?.lines || []) !== JSON.stringify(lines) };
}

// 停顿估算：与 story-craft 的 speechCheck 用**同一套**标点规则——
// 两处各写一套的话，体检说"这一段说不完"而时间轴说"还富余"，用户不知道该信谁。
const pauseOf = text => {
  const s = String(text || '');
  const inner = (s.match(/[，、；：,;]/g) || []).length;
  const end = (s.match(/[。！？!?…~—]/g) || []).length;
  return inner * 0.2 + end * 0.45;
};

// 语义时间轴：从文本算每句的起止与整段时长（秒，四舍五入到 0.1）。
// 语义锚点（anchor）不变，只有秒数变——这就是"改一句，后面自己重排"。
export function computeTimeline(lines = [], { charsPerSec = null } = {}) {
  const rate = Number(charsPerSec) > 0 ? Number(charsPerSec) : (SPEECH.slowMax + SPEECH.fastMin) / 2; // 默认取 3.5~5 的中值 4.25
  let cursor = 0;
  const out = (Array.isArray(lines) ? lines : []).map(line => {
    const chars = speakableChars(line?.text);
    const seconds = Math.max(0.3, Number((chars / rate + pauseOf(line?.text)).toFixed(1)));
    const start = Number(cursor.toFixed(1));
    const end = Number((cursor + seconds).toFixed(1));
    cursor = end;
    return { id: line?.id || '', anchor: line?.anchor ?? 0, speaker: line?.speaker || '', text: line?.text || '', chars, seconds, start, end };
  });
  return { total: Number(cursor.toFixed(1)), rate, estimated: true, lines: out };
}

// 给人看的一行（界面直接用）：`[0.0–2.4s] 林晚：你挡住了我的视线。`
export function formatLine(line) {
  return `[${line.start.toFixed(1)}–${line.end.toFixed(1)}s] ${line.speaker}：${line.text}`;
}

// 语义锚点的用处：改了一句之后，**只有它和它之后**的位置会变。
// 这个函数给测试与界面一个可断言的形状：{ moved: [ids], kept: [ids] }
export function diffTimeline(before = [], after = []) {
  const prev = new Map((before || []).map(l => [l.id, l]));
  const moved = [];
  const kept = [];
  for (const line of after || []) {
    const old = prev.get(line.id);
    if (old && Math.abs(old.start - line.start) < 0.05) kept.push(line.id);
    else moved.push(line.id);
  }
  return { moved, kept };
}
