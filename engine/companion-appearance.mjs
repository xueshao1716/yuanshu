// The visual companion is rendered by the frontend, but its semantic description
// is a runtime fact that can be safely shared with the companion model.
export const COMPANION_APPEARANCE = Object.freeze({
  neutral: Object.freeze({ label: '静候', asset: 'yuanshu-listening-v1.webp', description: '真人女性形象，面向前方，安静地陪伴与等待。' }),
  working: Object.freeze({ label: '工作中', asset: 'yuanshu-working-v1.webp', description: '真人女性形象，坐在桌前专注看屏幕，处于工作姿态。' }),
  reading: Object.freeze({ label: '阅读中', asset: 'yuanshu-reading-v1.webp', description: '真人女性形象，手持书本并低头阅读，处于阅读姿态。' }),
  resting: Object.freeze({ label: '休息中', asset: 'yuanshu-resting-v1.webp', description: '真人女性形象，姿态放松，像是在短暂休息。' }),
  daydreaming: Object.freeze({ label: '放空中', asset: 'yuanshu-daydreaming-v1.webp', description: '真人女性形象，视线游离、神情放空，处于发呆姿态。' }),
  listening: Object.freeze({ label: '倾听中', asset: 'yuanshu-listening-v1.webp', description: '真人女性形象，面向用户，安静倾听。' }),
  responding: Object.freeze({ label: '回应中', asset: 'yuanshu-responding-v1.webp', description: '真人女性形象，面向用户，正在回应。' }),
});

// Stable identity prompt for the real-person companion. This is descriptive
// context for the model, not an instruction to generate an image on its own.
export const COMPANION_IDENTITY_PROMPT = `成年虚构东亚女性真人形象，二十多岁，身材自然匀称；腰下超长直黑发，厚直刘海，冷静而温和的自然表情，真实皮肤纹理，不是动漫、卡通或CG。身份锚点是同一张脸、同样的发型、年龄感、体态比例与真人摄影质感，不是固定某一套衣服。服装可随场景自然变化，例如简洁日常服、JK风格制服、百褶短裙搭配上衣、休闲家居服或工作服；保持明确的成年人外观与自然日常穿搭，短裙、短袖等正常露肤可以，不做色情化呈现。基准画面可使用极简现代黑色楼梯与白墙、冷白自然窗光和柔和正面补光，纪实编辑时尚摄影，保留环境留白和真实材质。禁止塑料磨皮、夸张性感姿势、私密部位裸露、额外肢体、文字和水印。工作中、阅读中、休息中等状态只改变姿态、视线、场景和服装，不改变这个人的身份与基础外观。`;

export function appearanceFor(action = 'neutral') {
  return COMPANION_APPEARANCE[action] || COMPANION_APPEARANCE.neutral;
}

export function appearanceCatalog() {
  return Object.fromEntries(Object.entries(COMPANION_APPEARANCE).map(([action, value]) => [action, { ...value }]));
}
