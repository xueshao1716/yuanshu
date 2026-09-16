// 台词的稳定身份与语义时间轴：这一项的验收标准是"改一句台词，只有它和它之后移动"。
// 身份错了（比如按行号编号）就会整体漂移，那正是要治的病。
import test from 'node:test';
import assert from 'node:assert/strict';
import { stableLineId, syncLines, computeTimeline, diffTimeline, formatLine } from '../../engine/story-lines.mjs';
import { speechCheck } from '../../engine/story-craft.mjs';

const beatWith = dialogue => ({ id: 'b1', kind: 'video', prompt: '两人站在站台', dialogue });

test('身份稳定：同文本复跑 id 不变；标点/空白不同算同一句', () => {
  const a = stableLineId('林晚', '你挡住了我的视线。');
  const b = stableLineId('林晚', '你挡住了我的视线');
  assert.equal(a, b, '只改句号不该换身份');
  assert.match(a, /^ln-[0-9a-f]{6}$/);
  assert.notEqual(stableLineId('林晚', '你挡住了我的视线'), stableLineId('周远', '你挡住了我的视线'), '换人就是另一句');
});

test('改中间一句：前一句不动，后一句跟着移——这就是语义时间轴', () => {
  const dialogue = ['林晚：你挡住了我的视线。', '周远：抱歉。', '林晚：请向左侧移动十厘米。'].join('\n');
  const { lines } = syncLines(beatWith(dialogue));
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map(l => l.anchor), [0, 1, 2], '锚点就是语义位置（第几句）');
  const t1 = computeTimeline(lines);

  // 把第 2 句改长（同一句话拉长，id 会变，所以第 3 句之前的位置必然右移）
  const longer = ['林晚：你挡住了我的视线。', '周远：抱歉抱歉抱歉，我马上就往旁边让开，真的非常抱歉。', '林晚：请向左侧移动十厘米。'].join('\n');
  const { lines: lines2 } = syncLines(beatWith(longer));
  const t2 = computeTimeline(lines2);
  const byText = t => Object.fromEntries(t.lines.map(l => [l.text, l]));
  assert.equal(byText(t2)['你挡住了我的视线。'].start, byText(t1)['你挡住了我的视线。'].start, '前一句不能动');
  assert.ok(byText(t2)['请向左侧移动十厘米。'].start > byText(t1)['请向左侧移动十厘米。'].start, '后一句要跟着往后移');
  assert.ok(t2.total > t1.total, '整段变长了');
  const d = diffTimeline(t1.lines, t2.lines);
  assert.ok(d.moved.length >= 2 && d.kept.includes(byText(t2)['你挡住了我的视线。'].id), 'diff 要说清谁动了谁没动');
});

test('与体检同源：逐句合计与 speechCheck 的区间一致（不许两套算法各算一个数）', () => {
  const dialogue = ['林晚：别催，给我一点时间。', '周远：车不会来了。'].join('\n');
  const { lines } = syncLines(beatWith(dialogue));
  const t = computeTimeline(lines);
  const whole = speechCheck(lines.map(l => l.text).join(''));
  assert.ok(t.total >= whole.minSec - 0.6 && t.total <= whole.maxSec + 0.6,
    `时间轴 ${t.total}s 要落在体检区间 ${whole.minSec}~${whole.maxSec}s 内（同一套语速常量）`);
  assert.equal(t.rate, 4.25, '默认取 3.5~5 的中值');
  assert.ok(t.estimated, '估计值要标出来，别当实测');
});

test('秒数只是估计：可以按语速档位重算，锚点与 id 不受影响', () => {
  const { lines } = syncLines(beatWith('林晚：请向左侧移动十厘米。'));
  const slow = computeTimeline(lines, { charsPerSec: 3.5 });
  const fast = computeTimeline(lines, { charsPerSec: 5 });
  assert.ok(slow.total > fast.total, '慢档要更长');
  assert.deepEqual(slow.lines.map(l => l.id), fast.lines.map(l => l.id), '换档位不该改身份');
  assert.deepEqual(slow.lines.map(l => l.anchor), fast.lines.map(l => l.anchor), '也不该动锚点');
  assert.match(formatLine(slow.lines[0]), /^\[0\.0–[\d.]+s?\] 林晚：请向左侧移动十厘米。$/);
});

test('没有台词或坏输入不炸：空行表、空文本都给出可用的空时间轴', () => {
  assert.deepEqual(syncLines({ dialogue: '' }).lines, []);
  assert.deepEqual(computeTimeline([]).lines, []);
  assert.equal(computeTimeline([]).total, 0);
  assert.deepEqual(syncLines({}).lines, []);
});
