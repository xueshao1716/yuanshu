/** Skill inventories may contain old strings or structured loader diagnostics. */
// 加载器给的是英文原文（含私有路径），这里翻成一句人话：说清是哪个技能、什么问题、影响什么。
const skillName = path => {
  const m = String(path || '').match(/[\\/]([^\\/]+)[\\/]SKILL\.md$/i);
  return m ? m[1] : '';
};
function translate(item) {
  if (typeof item === 'string') return item;
  const message = item?.message;
  if (typeof message !== 'string' || !message.trim()) return null;
  const name = skillName(item.path);
  const collided = message.match(/^name "([^"]+)" collision$/);
  if (item.type === 'collision' || collided) {
    const n = collided?.[1] || item.collision?.name || name || '某个技能';
    return `技能「${n}」装了两份，已使用其中一份，另一份被忽略。可删掉重复的那份。`;
  }
  if (/name contains invalid characters/.test(message))
    return `技能「${name || '某个技能'}」的名称含大写或空格，不符合命名规范；仍可使用，建议改成小写加连字符。`;
  return message;
}
export function diagnosticMessages(value) {
  if (!Array.isArray(value)) return [];
  return value.map(translate).filter(message => typeof message === 'string' && message.trim());
}
