// 万像技能的章节索引生成器。
//
// 为什么需要它：两个技能的 SKILL.md 都写着"复杂需求必须读取完整文档"，
// 而源文分别是 6652 行 / 1553 行——整份读进来要十几万 token，等于没读。
// 这里把"第几章 = 第几行"机械算出来，写进各技能的 INDEX.md，让 agent 用
// read 的 offset/limit 精确取章。
//
// 用**脚本生成**而不是手抄：手抄的行号一定会随源文漂移，而且漂了没人知道。
// tests/unit/skills-contract.test.mjs 会把 INDEX.md 与这里算出来的结果对比——
// 改了源文却不重跑本脚本，测试就会红。
//
// 本文件刻意放在仓库根的 scripts/（**不是** skills/ 下面）：skills/ 的每个子目录
// 都会被当成一个技能去读 SKILL.md，往里塞工具脚本会污染技能目录列表。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SKILLS = path.join(path.dirname(import.meta.dirname), 'skills')

// 章节标题。三种写法都要认，因为这几个源文档风格不一样：
//   ① `第X章：…`（人物/平面/多AI/短剧 都用它）——平面文档从第五章起还套了 `### **…**`，
//      只认 `^第X章` 会漏掉 5/6/7 三章（实测踩到），所以要把 # 与 ** 都容掉；
//   ② markdown 标题 `#…`；
//   ③ 孤行的英文小节名（提示词架构师那份就是 `Profile` / `Goals` / `Workflow` / `Rules` / `Initialization`）。
// 刻意**只索引到章/一级小节**：更细的 `N.M` 太密（多AI那份有 176 个候选），列出来反而没法导航——
// 章级给区间，细的用行号区间自己定位。
const CH = /^#{0,4}\s*\**\s*第([一二三四五六七八九十百零〇\d]+)[章篇]\s*[:：]?\s*(.*?)\**\s*$/
// 只认**一级** markdown 标题作为"节"。`### **4.1 设计生成基本范式**` 这类子节不进来：
// 章级索引才导航得动，子节混进来会把章表冲成几十行（平面那份实测有 20+ 个子节）。
// 注意 `### 第一章 …` 不受影响——它先被上面的 CH 规则认成"章"。
const MD = /^#\s+(\S.*)$/
const EN = /^([A-Z][A-Za-z0-9 /-]{2,28})$/
// 代码围栏：**一到三个**反引号都算，且允许缩进。提示词架构师那份用单反引号 `` `markdown ``、
// 还缩进了 5 格，两个条件都要容，否则模板段里的小节名会被当成结构标题（实测重复了 5 个小节名）。
const FENCE = /^\s*(`{1,3})([A-Za-z]*)\s*$/
export function cnNum(s) {
  if (/^\d+$/.test(s)) return Number(s)
  let n = 0, cur = 0
  for (const ch of s) {
    if (ch === '十') { cur = (cur || 1) * 10; n += cur; cur = 0 }
    else if (CN[ch] != null) cur = CN[ch]
  }
  return n + cur
}

// 一行是不是"节标题"：返回 {kind, no?, title} 或 null。
// **缩进 ≤2 格**才算标题，这是量出来的：
//   · 平面文档第 8–14 章缩进 1 格（必须收）；Python 注释 `        # 标准公式:` 缩进 8 格、
//     表格行以 \t 开头（都不收）；提示词架构师模板体缩进 5 格（不收）。
// 一个阈值同时管住四种情况，比逐个写特例靠谱。
function sectionOf(line) {
  if (!/^ {0,2}\S/.test(line)) return null
  const t = line.trim()
  if (!t || t.length > 60) return null
  const ch = t.match(CH)
  if (ch) return { kind: 'chapter', no: cnNum(ch[1]), title: (ch[2] || '').trim() }
  if (/^`/.test(t)) return null
  const md = t.match(MD)
  if (md) return { kind: 'section', title: md[1].trim().replace(/\**\s*$/, '') }
  const en = t.match(EN)
  if (en) return { kind: 'section', title: en[1].trim() }
  return null
}
const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

function firstSentence(lines, from) {
  for (let i = from; i < Math.min(lines.length, from + 12); i++) {
    const t = lines[i].trim().replace(/^[*#\s`]+/, '')
    if (t.length >= 12 && !/^[{}\[\]"']/.test(t)) return t.slice(0, 46)
  }
  return ''
}

export function buildIndex({ file, title, note }) {
  // 行尾先归一：`core.autocrlf=true` 的机器上 checkout 出来是 CRLF，若不归一，
  // 抽出来的"每章首句"会带上 \r，同一份源文在不同机器上生成出**不同**的 INDEX.md
  // （tests/unit/skills-contract.test.mjs 会因此报"与源文不一致"，而源文其实没变）。
  const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const lines = raw.split('\n')
  const all = []
  let inFence = false
  lines.forEach((l, i) => {
    if (FENCE.test(l)) { inFence = !inFence; return }   // 围栏里的 `# xxx` 是注释/模板，不是标题
    const s = sectionOf(l)
    if (!s) return
    // 围栏只挡"小节"，**不挡"第X章"**：人物那份的反引号标记共 347 个（奇数），
    // 收尾时围栏还是开着的，若连章标题一起挡掉，最后 21 章会整片消失（实测踩到）。
    // 章标题是顶格 `### 第X章`，极少出现在代码块里；万一出现，下面的序列规则也会拦住。
    if (inFence && s.kind !== 'chapter') return
    all.push({ ...s, line: i + 1 })
  })
  // 章号必须**连续**才算结构章：正文里的样例标题（appendix 里的小说章名、示例输出）
  // 会打乱序列，把它们挪到"非序列标题"里如实列出，而不是混进章节表让人按错行号去读。
  // **但"重号"不算样例**：平面文档第 89 行与第 116 行都是"第四章"（一个是色彩引擎、
  // 一个基本范式库），那是编号错误造成的真重复——两段都得进章节表（行号区间才对），
  // 同时由下面的 dupNo 报出来。早期版本把它归进 stray，缺陷就被"样例"这个说法盖掉了。
  const chapters = []
  const stray = []
  const seenNo = new Set()
  let expect = 1
  for (const s of all) {
    if (s.kind !== 'chapter') { chapters.push(s); continue }
    if (s.no === expect) { chapters.push(s); seenNo.add(s.no); expect += 1 }
    else if (seenNo.has(s.no)) chapters.push(s)
    else stray.push(s)
  }
  const supplements = []
  lines.forEach((l, i) => { if (/【旧版补充】/.test(l)) supplements.push(i + 1) })
  const broken = []
  lines.forEach((l, i) => {
    const t = l.trim()
    if (t.length > 18 && /^[0-9]{1,3}/.test(t) && /["'）)】]\s*,\s*…?\s*$/.test(t) && !/[。！？]\s*$/.test(t)) broken.push({ line: i + 1, text: t.slice(0, 60) })
  })
  const suspicious = []
  lines.forEach((l, i) => {
    const t = l.trim()
    if (t.length > 14 && /^[0-9]{1,3}\s*,/.test(t) && /["'}\])）】]\s*,?\s*$/.test(t)) suspicious.push({ line: i + 1, text: t.slice(0, 50) })
  })
  const chars = raw.replace(/\s/g, '').length
  const numbered = chapters.filter(c => c.kind === 'chapter')
  const out = []
  out.push(`# ${title} · 章节索引`, '')
  out.push('> 本文件由 `scripts/gen-skill-index.mjs` 从源文件**机械生成**（行号即 `read` 的 offset），')
  out.push('> 并由 `tests/unit/skills-contract.test.mjs` 核对——改了源文却不重跑生成器，测试会红。')
  out.push('> 为什么要它：源文几千行，整份读进来要十几万 token。按需读，先查这里。', '')
  out.push(`- 源文件：\`${path.basename(file)}\`（${lines.length} 行 / ${chars} 非空白字符）`)
  if (numbered.length) out.push(`- 章标题：**${numbered.length}** 个；编号去重后 **${new Set(numbered.map(c => c.no)).size}** 个`)
  else out.push(`- 一级小节：**${chapters.length}** 个（这份源文没有"第X章"编号）`)
  if (note) out.push('', note)
  out.push('', '## 章节 → 行号', '', '| 节 | 标题 | 行号 | 这一节在讲什么 |', '|---|---|---|---|')
  for (const [i, c] of chapters.entries()) {
    const end = i + 1 < chapters.length ? chapters[i + 1].line - 1 : lines.length
    const label = c.kind === 'chapter' ? `第${c.no}章` : `${i + 1}`
    out.push(`| ${label} | ${c.title || '（无标题）'} | ${c.line}–${end} | ${firstSentence(lines, c.line)} |`)
  }
  const missing = []
  if (numbered.length) {
    for (let n = 1; n <= Math.max(...numbered.map(c => c.no)); n++) if (!numbered.some(c => c.no === n)) missing.push(n)
  }
  const dupNo = [...new Set(numbered.map(c => c.no))].filter(n => numbered.filter(c => c.no === n).length > 1)
  // 章标题覆盖不到的文末部分（附录/样例/代码）要说出来，否则人会以为"最后一章一直到文末"。
  // 但只有**明显偏长**才值得说：末章 127 行里当然没有新章标题，那不是缺陷。
  const lastLine = chapters.length ? chapters[chapters.length - 1].line : 1
  const tailLines = lines.length - lastLine
  const avgChapter = chapters.length > 1 ? Math.round((lastLine - chapters[0].line) / (chapters.length - 1)) : lines.length
  out.push('', '## 源文件已知缺陷（不是我加的，是原始材料就有的）', '')
  if (missing.length) out.push(`- **缺章**：第 ${missing.join('、')} 章在源文件里没有正文。`)
  for (const n of dupNo) {
    const items = chapters.filter(c => c.no === n)
    out.push(`- **章号重复**：第 ${n} 章出现了 ${items.length} 次（${items.map(c => `第 ${c.line} 行「${c.title}」`).join('、')}）。引用这一章时**必须带行号**，否则读者不知道指哪一个。`)
  }
  if (supplements.length) out.push(`- **【旧版补充】块位置错乱**：合并时把旧版补充**放在了下一个章标题之前**（而不是它所属章节的末尾），共 ${supplements.length} 处，行号：${supplements.join('、')}。读到某一章时若发现内容"眼熟但顺序怪"，多半就是它。`)
  if (broken.length) out.push(`- **断句残片**：抽取时丢掉前半句的孤行 ${broken.length} 处：${broken.map(b => `第 ${b.line} 行「${b.text}…」`).join('；')}。这些行**不要引用**。`)
  if (suspicious.length) out.push(`- **疑似残缺**（也可能是 JSON 断行，用之前先看上下文）：${suspicious.map(s => `第 ${s.line} 行「${s.text}」`).join('；')}。`)
  if (stray.length) out.push(`- **不在章号序列里的标题**（${stray.length} 处）：${stray.slice(0, 12).map(s => `第 ${s.line} 行「${s.title || `第${s.no}章`}」`).join('、')}${stray.length > 12 ? ` 等 ${stray.length} 处` : ''}。这些多半是**正文里的样例**（附录里的小说章名、示例输出），也可能是编号错误造成的重复——按上面的行号区间读的时候，遇到"内容对不上标题"就来这里对一下。`)
  if (tailLines > 200 && tailLines > avgChapter * 1.2) out.push(`- **末章之后还有 ${tailLines} 行没有章标题**（第 ${lastLine + 1}–${lines.length} 行）：属附录 / 样例 / 代码段，需要时按行号区间自行读。`)
  if (!missing.length && !dupNo.length && !supplements.length && !broken.length && !suspicious.length && !stray.length && tailLines <= 100) out.push('- 没发现缺章、重号、错位或残片。')
  out.push('')
  return out.join('\n')
}

// 抽取文本一律叫 `src_full.txt`（万像那两个是历史名，保持不变并在此登记）。
// 每个条目都要有 `source`：源文档在哪 —— 索引里写清"从哪抽的"，别让人以为 txt 就是原件。
export const TARGETS = [
  {
    skill: 'wanxiang-design',
    file: path.join(SKILLS, 'wanxiang-design', 'wx_design_full.txt'),
    out: path.join(SKILLS, 'wanxiang-design', 'INDEX.md'),
    title: '万像平面设计提示词生成系统',
    note: '> 原文是 `万像平面-完整系统.docx`（Word 二进制，**read 工具读不了**）。\n> `wx_design_full.txt` 是从它抽出的可读文本（`node scripts/extract-docx.mjs`）。\n> 原文与抽取文本并存：要核对原文措辞看 docx，要读内容用 txt。',
  },
  {
    skill: 'wanxiang-portrait',
    file: path.join(SKILLS, 'wanxiang-portrait', 'wx_full.txt'),
    out: path.join(SKILLS, 'wanxiang-portrait', 'INDEX.md'),
    title: '万像人物写真提示词生成系统',
    note: '> 源文件是"合并版"：以《万像人物提示词生成手册 4.docx》（37 章修订版）为主体，逐章补回旧版 PDF 独有内容。\n> 我没有改写这份源文（那是对你材料的改动），而是把它的**真实结构**摊在这里。',
  },
  {
    skill: 'multi-ai-roleplay',
    file: path.join(SKILLS, 'multi-ai-roleplay', 'src_full.txt'),
    out: path.join(SKILLS, 'multi-ai-roleplay', 'INDEX.md'),
    title: '多AI角色扮演系统 V20.0（创世版）',
    note: '> 原文是 `多AI角色扮演系统V20.0.docx`（117KB，Word 二进制，**read 工具读不了**）。\n> `src_full.txt` 是从它抽出的可读文本（`node scripts/extract-docx.mjs`）。',
  },
  {
    skill: 'shortform-genesis',
    file: path.join(SKILLS, 'shortform-genesis', 'src_full.txt'),
    out: path.join(SKILLS, 'shortform-genesis', 'INDEX.md'),
    title: 'SHORTFORM-GENESIS-PRO V4.3',
    note: '> 原文是 `SHORTFORM-GENESv4.3.docx`（Word 二进制，**read 工具读不了**）。\n> `src_full.txt` 是从它抽出的可读文本（`node scripts/extract-docx.mjs`）。\n> 注意：`D:\\遗产` 里另有一份同名 docx，**内容与本目录这份不同**（版本不同）——以本目录这份为准。',
  },
  {
    skill: 'prompt-architect',
    file: path.join(SKILLS, 'prompt-architect', 'src_full.txt'),
    out: path.join(SKILLS, 'prompt-architect', 'INDEX.md'),
    title: '提示词架构师 2.0',
    note: '> 原文是 `提示词架构师2.0版本.docx`（Word 二进制，**read 工具读不了**）。\n> `src_full.txt` 是从它抽出的可读文本（`node scripts/extract-docx.mjs`）——只有 65 行，\n> 需要精确照抄输出格式时**整份读**即可，不用挑章。',
  },
]

function main() {
  for (const t of TARGETS) {
    const text = buildIndex(t)
    fs.writeFileSync(t.out, text, 'utf8')
    console.log(`写入 ${path.relative(SKILLS, t.out)}（${text.split('\n').length} 行）`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
