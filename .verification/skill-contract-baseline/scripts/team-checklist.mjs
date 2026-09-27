// Missing evidence is never a pass. Preserve one result per expected check.
export function normalizeChecklist(specs, answers, issues, reviewerOk = true) {
  const rows = Array.isArray(answers) ? answers : [];
  const problems = Array.isArray(issues) ? issues : [];
  return specs.map(spec => {
    const matches = rows.filter(row => row && row.id === spec.id);
    const issue = problems.find(item => (String(item?.where || '').match(/V-\d{2}/g) || []).includes(spec.id));
    const row = matches.length === 1 ? matches[0] : null;
    const verified = reviewerOk && row && typeof row.pass === 'boolean';
    const pass = !!verified && row.pass === true && !issue;
    return { id: spec.id, pass, status: !verified ? 'unverified' : pass ? 'passed' : 'failed',
      note: !reviewerOk ? '校验调用失败，待复核' : !row ? '模型漏答或重复条目，待复核' : !verified ? '判定不是明确布尔值，待复核' : issue ? `存在问题：${issue.what || issue.where}` : String(row.note || (pass ? '明确通过' : '未通过')) };
  });
}
