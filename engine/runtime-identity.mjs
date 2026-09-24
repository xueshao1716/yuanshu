// Host facts describe this execution, independently of protected persona files.
export function runtimeIdentity({ engine, model } = {}) {
  const label = { yuanshu: '元枢自制循环', pi: 'pi SDK 兼容适配器', dsh: 'dsh' }[engine];
  if (!label) return '';
  return [
    '本轮宿主运行事实：产品是元枢（Yuanshu）工作台。',
    `执行引擎：${label}。`,
    model?.provider && model?.id ? `文本模型：${model.provider}/${model.id}（开轮模型；若发生降级，以实际调用记录为准）。` : '',
    '人格、文本模型、媒体模型、执行引擎是不同概念。pi 路径、兼容工具名及旧会话自述不能证明本轮运行在 pi 引擎；本轮以宿主运行事实为准。媒体工具的模型以该工具返回为准。',
  ].filter(Boolean).join('\n');
}
