// Describe the selected request's capabilities; this never grants permission.
export function toolAvailabilityPrompt(names = []) {
  const available = [...new Set(names.filter(name => typeof name === 'string' && name))];
  if (!available.length) return '【本轮工具事实】没有工具可用。不要假装执行命令或读写文件，需要外部资料时说明限制。';
  const fileTools = ['read', 'write', 'edit'].every(name => available.includes(name));
  return `【本轮工具事实】可用工具：${available.join('、')}。以本轮工具定义为准，不要根据历史回复声称只能使用 bash。${fileTools ? '文件读取和修改优先使用 read/write/edit；命令、批处理和程序运行再用 bash（如可用）。' : '只使用已列出的工具，不要宣称具有未提供的能力。'}规划模式、审批和安全限制仍有效，不得通过 bash 绕过其他工具拒绝的权限。`;
}
