export const SCENES = [
  { id: 'moon', label: '月下', title: '把想象留给夜空', bg: '#182c45', ink: '#f4ead7', accent: '#efc982', floor: '#304963' },
  { id: 'garden', label: '花园', title: '让小想法慢慢发芽', bg: '#e0e9ce', ink: '#294638', accent: '#c16848', floor: '#b7c9a4' },
  { id: 'studio', label: '工作室', title: '今天，也造一点新东西', bg: '#efdfca', ink: '#523c31', accent: '#b75032', floor: '#c9ab8f' },
];
export const sceneFor = id => SCENES.find(s => s.id === id) || SCENES[0];
const IDEAS = [
  ['留一点空白', '删掉一个多余的元素，让真正想说的更清楚。'],
  ['换个观看角度', '把眼前的题目，讲给十岁时的自己听。'],
  ['给灵感一个名字', '用三个词，为还没成形的想法起个名字。'],
  ['先造一个小样', '先做最有趣的一小块，再决定下一步。'],
  ['借一抹颜色', '从今天看到的风景里，借一种颜色进作品。'],
  ['试试反过来', '把一个习以为常的步骤倒过来，会怎样？'],
  ['收集一个细节', '记下一处差点被忽略的细节，它可能是开头。'],
];
export function dailyIdea(now = new Date(), offset = 0) {
  const year = now.getFullYear(), month = now.getMonth() + 1, day = now.getDate();
  const serial = Math.floor(Date.UTC(year, month - 1, day) / 86400000);
  const index = ((serial + offset) % IDEAS.length + IDEAS.length) % IDEAS.length;
  return { date: `${year}.${String(month).padStart(2, '0')}.${String(day).padStart(2, '0')}`, title: IDEAS[index][0], text: IDEAS[index][1] };
}
// Shared geometry keeps the on-screen set and the exported keepsake identical.
export function sceneBackdrop(id) {
  const s = sceneFor(id);
  const art = s.id === 'moon'
    ? '<circle cx="211" cy="56" r="28" fill="#efc982"/><circle cx="222" cy="47" r="25" fill="#182c45"/><path d="M46 43v8m-4-4h8M91 80v6m-3-3h6M248 105v6m-3-3h6" stroke="#f4ead7" stroke-width="2"/>'
    : s.id === 'garden'
      ? '<g fill="#c16848"><circle cx="46" cy="74" r="12"/><circle cx="62" cy="74" r="12"/><circle cx="54" cy="62" r="12"/><circle cx="54" cy="86" r="12"/></g><circle cx="54" cy="74" r="7" fill="#efdfca"/><path d="M54 100v70M222 170v-53" stroke="#294638" stroke-width="3"/><ellipse cx="236" cy="133" rx="17" ry="8" fill="#78936a" transform="rotate(-35 236 133)"/><ellipse cx="208" cy="150" rx="17" ry="8" fill="#78936a" transform="rotate(35 208 150)"/>'
      : '<path d="M38 38h62v85H38z" fill="#f9f1e5"/><circle cx="69" cy="72" r="18" fill="#b75032"/><path d="M204 147v-61l34-27" fill="none" stroke="#523c31" stroke-width="4"/><path d="M219 59l28-11 10 25z" fill="#b75032"/>';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 220"><path fill="${s.bg}" d="M0 0h280v220H0z"/>${art}<path fill="${s.floor}" d="M0 174h280v46H0z"/><ellipse cx="140" cy="187" rx="66" ry="17" fill="${s.ink}" opacity=".14"/><path d="M85 177v9c0 18 110 18 110 0v-9" fill="${s.accent}"/><ellipse cx="140" cy="177" rx="55" ry="13" fill="${s.ink}" opacity=".9"/></svg>`;
}
