// Local legacy video-script profile, not a complete V20/V25/V26 implementation.
export const rolesSpec = { items: [
  { id: 'ANALYST', cn: '分析师', tier: '协调层', duty: '拆解视频脚本需求与约束' },
  { id: 'VIDEO', cn: '视频脚本', tier: '执行层', duty: '编写分镜和提示词' },
  { id: 'GUARDIAN', cn: '守护者', tier: '协调层', duty: '检查合规与约束' },
  { id: 'ARBIT', cn: '仲裁员', tier: '决策层', duty: '裁决冲突并生成终稿草稿' },
  { id: 'REVIEWER', cn: '审查者', tier: '协调层', duty: '逐条审阅并保留未通过项' },
] };
export const checklistSpec = { id: 'video-standard', status: 'draft-by-yuanshu', items: [
  { id: 'V-01', name: '钩子', check: '前3秒有明确钩子、悬念或反常识' },
  { id: 'V-02', name: '时长与节奏', check: '3镜时长相加为10秒' },
  { id: 'V-03', name: '景别齐全', check: '至少2种景别' },
  { id: 'V-04', name: '运镜明确', check: '每镜写明运镜' },
  { id: 'V-05', name: '一致性键', check: '人物外观、服装、道具关键特征跨镜一致' },
  { id: 'V-06', name: '动态真实感', check: '具体物理动作与次级运动，不是静态摆拍' },
  { id: 'V-07', name: '光线与氛围', check: '光源方向、色温和主题一致' },
  { id: 'V-08', name: '负面清单', check: '列出变形、多指、文字乱码、风格漂移等应避免的失败模式' },
  { id: 'V-09', name: '中文零错字', check: '文字无错字，不依赖视频模型直接生成中文' },
  { id: 'V-10', name: '平台适配', check: '画幅与平台合规约束明确，无版权风险元素' },
  { id: 'V-11', name: '可执行性', check: '提示词含主体、运动、场景、镜头语言、光影；不代表真实视频已生成' },
  { id: 'V-12', name: '草稿完整', check: '脚本、分镜、投喂提示词三件齐备；仍须人工验收' },
] };
