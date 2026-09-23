// Conservative lower-bound check, not a semantic/content acceptance verdict.
// Only explicit second-based shots with labelled quoted speech are measurable.
export function inspectTimedSpeech(draft) {
  const text = String(draft || '');
  const shots = [...text.matchAll(/(?:^|\n)\s*(?:[-*|]\s*)?(?:\*\*)?(\d+(?:\.\d+)?)\s*(?:秒|s)?\s*[-—–~～至]\s*(\d+(?:\.\d+)?)\s*(?:秒|s)(?:\*\*)?/g)];
  const issues = [];
  let checked = 0, unresolved = 0;
  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const block = text.slice(shot.index + shot[0].length, shots[i + 1]?.index ?? text.length)
      .split(/\n\s*(?:#{1,6}\s|【[^】]+】\s*(?:\n|$))/)[0];
    const speeches = [...block.matchAll(/口播[：:]\s*[“"]([^”"\n]+)[”"]/g)];
    if (!speeches.length) continue;
    checked++;
    const duration = Number(shot[2]) - Number(shot[1]);
    const label = `${shot[1]}—${shot[2]}秒`;
    if (duration <= 0) { issues.push(`${label}镜头时长必须大于零`); continue; }
    // Separate conditional takes are alternatives. Test each, never sum branches.
    for (const [, speech] of speeches) {
      if (/【[^】]*】/.test(speech)) unresolved++;
      const known = speech.replace(/【[^】]*】/g, '');
      const count = (known.match(/[\p{Script=Han}\p{N}]|[a-zA-Z]+(?:['’-][a-zA-Z]+)*/gu) || []).length;
      if (count > duration * 4) {
        issues.push(`${label}口播已知字数至少${count}，超过每秒4字的${Math.floor(duration * 4)}字上限；缩短台词或延长镜头，实测字段改放字幕`);
      }
    }
  }
  return { checked, unresolved, issues: [...new Set(issues)] };
}

export const TEAM_REVIEW_RULES = `独立核对用户原始任务与待复核正文，不采信作者自称达标。只做审查，不重写方案。
按以下顺序找实质反例：
1. 所需成果是否逐份完整，能否直接使用；标题、开头提出的问题是否在本期结尾回答。
2. 每笔不可撤销付款之前能否确认总额不超预算。多店比较须先确认两店报价再付款，或给第二笔明确的剩余额度；已付的钱不能因为后续取消就记为0。“同价”须有同价筛选条件。
3. 镜头连续且总时长正确；每秒约3至4个字，实测占位内容填入后也要容得下。程序检查只覆盖识别出的片段，未识别、数字读法、条件分支仍需你核对。
4. 未发生的体验、售价、流量不能写成事实；必要待填字段可以用，但不能用空模板代替要求的逐份脚本。字幕和拍摄说明不能塞进口播；只依据已确认资源。
直接输出 JSON {"pass":true或false,"issues":["指出具体位置、违反的约束与最小修正"]}。最多列5个实质问题，总计500字以内；无问题才pass=true且issues=[]。不要嵌套result，不为体现工作量编造问题。`;
