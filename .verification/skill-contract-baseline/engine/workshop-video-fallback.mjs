// 视频规则扩写：模型没赶上也要出谁、衣服、动作，不能把原句贴进万能镜头。

const WORKS = [
  {
    re: /大话西游|至尊宝|紫霞/,
    subject: "至尊宝和紫霞仙子",
    look: "至尊宝白衣束发，紫霞紫衣披帛，古装布料有褶皱，没有现代拉链和球鞋",
    scene: "大漠山道，日光白晃，没有电线和柏油路",
    lighting: "烈日高反差，脸上一块硬影",
    style: "周星驰电影古装写实",
  },
];

function clauses(s) {
  return String(s || "").split(/[，,。；;]/).map((x) => x.trim()).filter(Boolean);
}

function isDialogueIdea(s) {
  return /对[话谈]|采访|口播|一问一答|聊天|说给|台词|对白|经典场景|是.+生的|[「『“"].+[」』”"]/.test(s);
}

export function parseVideoIdea(s) {
  const raw = String(s || "").trim();
  const parts = clauses(raw);
  const head = parts[0] || raw;
  const rest = parts.slice(1).join("，");
  const work = WORKS.find((w) => w.re.test(raw));
  if (work) {
    return {
      ...work,
      action: rest ? `对白，口型清楚，说到「${rest}」` : "对白，口型清楚",
      line: rest,
      dialogue: true,
    };
  }
  if (isDialogueIdea(raw)) {
    const place = head.replace(/经典场景|对谈|对话/g, "").trim() || "可辨认的地点";
    return {
      subject: /两人|二人/.test(raw) ? "两个人" : "对白里的两个人",
      look: "两人服装和身份能分开辨认，料子有褶皱",
      scene: place,
      action: rest ? `对白，口型清楚，说到「${rest}」` : "对谈，口型清楚",
      line: rest,
      lighting: "主光在说话的人脸上，听的人略暗半档",
      style: "写实电影感",
      dialogue: true,
    };
  }
  const who = raw.match(/^([\u4e00-\u9fffA-Za-z0-9]{2,8})(?=转身|走过|跑|跳|遁|站|看|低头)/);
  const act = raw.match(/(转身[^，。]{0,12}|遁入[^，。]{0,8}|走过[^，。]{0,8}|抬头[^，。]{0,8})/);
  const place = raw.match(/(夜色|空旷山道|山道|雨巷|老巷|车厢|茶馆|书房)/);
  const subject = who?.[1] || head;
  return {
    subject,
    look: `${subject}的衣服料子和身份清楚，不要塑料光`,
    scene: place?.[1] || "可辨认的地点",
    action: act?.[1] || rest || raw.replace(subject, "").replace(/^[，,\s]+/, "") || "做一个清楚的动作",
    line: "",
    lighting: "光线有方向",
    style: "写实电影感",
    dialogue: false,
  };
}

export function fallbackVideoExpand(idea) {
  const p = parseVideoIdea(idea);
  if (p.dialogue) {
    const memory = p.line ? `说到「${p.line.slice(0, 18)}」时两人眼神对上` : "开口那一拍，眼神对上";
    return {
      prompt: [
        `【总览】${p.subject}站在${p.scene}。${p.look}。正在${p.action}。${p.lighting}。过肩起幅，正反打一次，口型清楚，不烧字幕。${p.style}。`,
        `【记忆点】${memory}`,
        `【时间轴】\n[0-2秒 起] 双人中景·过肩·稳定器 | 先看清${p.subject}和${p.scene}，谁站哪边，衣服料子清楚\n[2-5秒 承] 过肩·听的人 | 听的人肩线和后脑切画面，对方开口，口型清楚\n[5-8秒 转] 近景·正反打 | 切到说话的人眼睛和嘴，只这一句\n[8-10秒 合] 双人中景·定格 | 回到两人，反应收住，不添第三人`,
        `【物理】\n- 主体运动：说话时下颌和喉结动，听的人眨眼点头，衣袖晚半拍\n- 环境交互：风或沙尘可看见，脚下地面有质感\n- 材质：${p.look}\n- 光学：${p.lighting}`,
        `【锁定】无字幕无BGM无变形；只这两个人，不烧对白文字；身份与服装不漂移。`,
        `【规格】时长10秒，画幅16:9，720P 清晰。`,
      ].join("\n"),
      fields: {
        subject: p.subject,
        action: p.action,
        scene: p.scene,
        lighting: p.lighting,
        camera: "过肩正反打",
        style: p.style,
        memory,
      },
      source: "fallback",
    };
  }
  return {
    prompt: [
      `【总览】${p.subject}在${p.scene}里${p.action}。${p.look}。${p.lighting}。${p.style}。`,
      `【记忆点】${p.action}最清楚的那一拍`,
      `【时间轴】\n[0-2秒 起] 中全景·稳定器 | 先看清${p.subject}和${p.scene}，衣服料子清楚\n[2-5秒 承] 中景·跟拍 | 开始${p.action}，镜头跟着走\n[5-8秒 转] 近景 | ${p.action}做到最清楚\n[8-10秒 合] 中景·缓收 | 动作收住`,
      `【物理】\n- 主体运动：${p.action}一次做完，衣角晚半拍\n- 环境交互：地点要有可看见的反应\n- 材质：${p.look}\n- 光学：${p.lighting}`,
      `【锁定】无字幕无BGM无变形；身份与服装不漂移；一次一个主要运镜。`,
      `【规格】时长10秒，画幅16:9，720P 清晰。`,
    ].join("\n"),
    fields: {
      subject: p.subject,
      action: p.action,
      scene: p.scene,
      lighting: p.lighting,
      style: p.style,
      memory: `${p.action}最清楚的那一拍`,
    },
    source: "fallback",
  };
}
