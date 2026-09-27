// 技能库的契约（**全部技能**，不只是万像那两个）。
//
// 这些技能是**给 agent 用的**：它们的失败方式和普通代码不同——
// 一次死链、一个读不到的二进制文件、一句"必须读完整文档"却没说第几行、
// 一句被截断到只剩前半截的 description，都会让 agent 直接放弃执行或走错路。
//
// 所以这里锁的是"指令能不能被执行"，四条：
//
//  1. description ≤120 字，且**触发语落在前 120 字**——
//     `engine/context-loader.mjs` 的 `loadSkillIndex()` 只取前 120 字进技能目录，
//     超出的部分等于不存在（目录里那行字是模型唯一能看见的）；
//  2. SKILL.md 里引用的文件必须真的存在（死链 = 指令无法执行）；
//     真属于"用户工程目录里的运行时产物"的，必须在旁边写明，不能让 agent 去 skills/ 里找；
//  3. 大源文（>20KB 文本）必须配 `INDEX.md`，且 `INDEX.md` 必须与
//     `scripts/gen-skill-index.mjs` 现算的结果**逐字一致**——源文改了却忘了重跑生成器，
//     索引就会骗人（这条把"骗人"变成红灯）；
//  4. 源文里真实存在的缺陷（重号章、错位的补充块、断句残片）必须被索引**如实声明**，
//     而不是藏起来；SKILL.md 也不得再出现被实测推翻的旧说法（"18 章""8.2 万字"这类）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadSkillIndex } from '../../engine/context-loader.mjs';
import { buildIndex, TARGETS } from '../../scripts/gen-skill-index.mjs';

const ROOT = path.resolve('.');
const SKILLS = path.join(ROOT, 'skills');
const DIRS = fs.readdirSync(SKILLS).filter(n => fs.existsSync(path.join(SKILLS, n, 'SKILL.md'))).sort();

// 行尾归一：`core.autocrlf=true`（本机就是）会在 checkout 时把文本文件写成 CRLF，
// 而生成器产出的是 LF。不归一的话，同一份源文在不同机器上会得出"不一致"的假红灯。
const lf = s => s.replace(/\r\n/g, '\n');
const readSkill = name => lf(fs.readFileSync(path.join(SKILLS, name, 'SKILL.md'), 'utf8'));
const frontmatter = raw => raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
const field = (fm, key) => {
  const m = fm[1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
};
const declared = name => {
  const fm = frontmatter(readSkill(name));
  assert.ok(fm, `${name} 缺 frontmatter（加载器就看不到它的 name/description）`);
  return { fm, name: field(fm, 'name'), desc: field(fm, 'description') };
};
// 目录树里的全部文件（相对技能目录），用于"抽取文本是否存在"这类判断。
const treeOf = name => {
  const out = [];
  (function walk(dir, prefix) {
    for (const x of fs.readdirSync(dir)) {
      const p = path.join(dir, x);
      if (fs.statSync(p).isDirectory()) walk(p, `${prefix}${x}/`);
      else out.push({ rel: `${prefix}${x}`, size: fs.statSync(p).size });
    }
  })(path.join(SKILLS, name), '');
  return out;
};

test('技能库非空，且每个技能目录都有 SKILL.md', () => {
  assert.ok(DIRS.length >= 15, `只找到 ${DIRS.length} 个技能——技能库被删了？`);
  for (const name of fs.readdirSync(SKILLS)) {
    // 忘了写 SKILL.md 的目录会被加载器**静默跳过**：它不进技能目录，模型永远不知道它存在。
    assert.ok(fs.existsSync(path.join(SKILLS, name, 'SKILL.md')), `skills/${name} 没有 SKILL.md，会被静默跳过`);
  }
});

test('每个技能的 frontmatter 可解析，name 与目录名一致', () => {
  for (const name of DIRS) {
    const { name: declaredName } = declared(name);
    assert.equal(declaredName, name, `${name} 的 frontmatter name 是「${declaredName}」——加载器/activate_skill 按目录名找文件`);
  }
});

test('description ≤120 字且触发语在前 120 字（加载器只取前 120 字进技能目录）', () => {
  for (const name of DIRS) {
    const { desc } = declared(name);
    assert.ok(desc.length > 0, `${name} 没有 description`);
    // 超过 120 字的部分模型根本看不到，等于没写——要么压到 120 字内，要么把关键信息前移。
    assert.ok(desc.length <= 120, `${name} 的 description 有 ${desc.length} 字，超过 120 会被截断：${desc.slice(0, 40)}…`);
    // 触发语必须在前 120 字里，否则"什么时候用这个技能"这件事在目录里是缺席的。
    const hit = /[\u4e00-\u9fff]/.test(desc) ? /当用户|使用时|当需要/.test(desc) : /Use (when|this|for)|use when/.test(desc);
    assert.ok(hit, `${name} 的 description 没写触发条件（中文写「当用户…」，英文写「Use when…」）：${desc}`);
  }
});

test('加载器必须真的读到每个技能的 description（CRLF/引号/缺 frontmatter 都会让它读不到）', () => {
  const idx = loadSkillIndex();
  const byName = new Map(idx.map(s => [s.name, s.desc]));
  for (const name of DIRS) {
    const { desc } = declared(name);
    assert.ok(byName.has(name), `技能目录里没有 ${name}——加载器跳过了它`);
    // desc ≤120 时加载器不该有任何截断；不等就说明它退回读了正文第一行（frontmatter 没解析成功）。
    assert.equal(byName.get(name), desc, `${name} 在技能目录里显示的不是它声明的 description：加载器没解析到 frontmatter`);
  }
});

test('SKILL.md 里引用的文件必须存在（死链 = agent 执行不了）', () => {
  // 形如 `xxx.md` 的引用才算文件引用；通配/占位（`type-*.md`、`souls/<name>.json`）
  // 和带空格的命令行（`python3 scripts/self_check.py <file>`）不是路径，跳过。
  const EXT = /\.(md|txt|docx|json|mjs|py|csv|pdf)$/;
  const SKIP = /[*<>§]|\s/;
  const EXTERNAL = /^(?:[A-Za-z]:[\\/]|https?:)/;
  // 「这不是本技能的文件」的标记：运行时产物 / 输出目录 / 外部根目录。
  const RUNTIME = /BOOK_ROOT|运行时|生成物|外部|安装目录/;
  let checked = 0;
  for (const name of DIRS) {
    const lines = readSkill(name).split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/`([^`\n]+)`/g)) {
        const ref = m[1];
        if (!EXT.test(ref) || SKIP.test(ref) || EXTERNAL.test(ref)) continue;
        checked++;
        const abs = path.join(SKILLS, name, ref);
        if (fs.existsSync(abs) || fs.existsSync(path.join(ROOT, ref))) continue;
        // 找不到时，宽容一点：引用所在段落里明确写了它属于外部/运行时产物，就放过——
        // 但要**明确写出来**，否则 agent 会去 skills/ 下找一个永远不存在的文件。
        // 窗口取 14 行：一节的开头声明（`## …（BOOK_ROOT/TRUTH/）`）要能罩住节里的整张清单。
        const near = lines.slice(Math.max(0, i - 14), i + 1).join('\n');
        assert.ok(RUNTIME.test(near), `${name} 引用了不存在的文件：${ref}（第 ${i + 1} 行）。要么改成真实路径，要么在附近写明它是运行时产物/外部目录`);
      }
    });
  }
  assert.ok(checked >= 20, `只检查到 ${checked} 个文件引用——引用提取规则坏了`);
});

test('大源文（>20KB）必须配可读文本 + INDEX.md，且 SKILL.md 要提到它们', () => {
  let big = 0;
  for (const name of DIRS) {
    const files = treeOf(name);
    const raw = readSkill(name);
    // 二进制 .docx：read 工具读不了 → 同目录必须有抽取文本，否则"读原文"是句空话。
    const docx = files.filter(f => f.rel.endsWith('.docx'));
    const txt = files.filter(f => f.rel.endsWith('.txt'));
    if (docx.length) assert.ok(txt.length, `${name} 里有 ${docx.length} 个 .docx（read 读不了），但没有抽取文本 .txt`);
    for (const t of txt.filter(f => f.size > 20000)) {
      big++;
      const base = path.basename(t.rel);
      assert.ok(raw.includes(base), `${name} 的 ${base} 有 ${t.size} 字节，SKILL.md 却没提它——agent 不会知道要读它`);
      assert.ok(raw.includes('INDEX.md'), `${name} 的 ${base} 太大（${t.size} 字节），SKILL.md 必须指向 INDEX.md（否则没法按章节读）`);
      const idxFile = path.join(SKILLS, name, 'INDEX.md');
      assert.ok(fs.existsSync(idxFile), `${name} 缺 INDEX.md（${base} ${t.size} 字节，整份读要十几万 token）`);
      // 索引必须是生成器产出的，不能是手抄的：手抄的行号一定会漂。
      assert.match(lf(fs.readFileSync(idxFile, 'utf8')), /机械生成/, `${name}/INDEX.md 不是生成器产出的（没有"机械生成"字样）`);
    }
  }
  assert.ok(big >= 4, `只有 ${big} 个大源文——检查逻辑是不是失效了`);
});

test('INDEX.md 必须与生成器现算的结果逐字一致（改了源文不重跑生成器 → 红灯）', () => {
  assert.ok(TARGETS.length >= 5, `生成器只登记了 ${TARGETS.length} 个源文`);
  for (const target of TARGETS) {
    assert.ok(fs.existsSync(target.file), `源文件不存在：${target.file}`);
    assert.equal(lf(fs.readFileSync(target.out, 'utf8')), buildIndex(target), `${path.relative(ROOT, target.out)} 与源文不一致：跑 \`node scripts/gen-skill-index.mjs\` 重新生成`);
    // 索引必须能被找到：SKILL.md 不指它，agent 就不知道它存在。
    assert.ok(readSkill(target.skill).includes('INDEX.md'), `${target.skill}/SKILL.md 没提 INDEX.md`);
  }
});

test('索引里的行号必须真的落在章节标题上（索引不能只是好看）', () => {
  for (const target of TARGETS) {
    const lines = lf(fs.readFileSync(target.file, 'utf8')).split('\n');
    const index = lf(fs.readFileSync(target.out, 'utf8'));
    const rows = [...index.matchAll(/^\| (\S+) \| (.*?) \| (\d+)–(\d+) \|/gm)];
    assert.ok(rows.length >= 3, `${path.basename(target.out)} 只解析出 ${rows.length} 行`);
    for (const [, label, , start, end] of rows) {
      const head = lines[Number(start) - 1] || '';
      if (/^第\d+章$/.test(label)) assert.match(head, /第[一二三四五六七八九十百零〇\d]+章/, `${path.basename(target.out)} 第 ${start} 行不是章节标题：「${head.slice(0, 40)}」`);
      else assert.ok(head.trim().length > 0, `${path.basename(target.out)} 第 ${start} 行是空行`);
      assert.ok(Number(end) <= lines.length && Number(end) >= Number(start), `行号区间 ${start}–${end} 不合法`);
    }
  }
});

test('源文里真实的缺陷必须在索引里如实声明（不许藏）', () => {
  // 平面文档实测：第 4 章重号（"全域色彩美学引擎" 与 "设计生成基本范式与核心模板库"）
  const design = lf(fs.readFileSync(path.join(SKILLS, 'wanxiang-design', 'INDEX.md'), 'utf8'));
  assert.match(design, /章号重复.*第 4 章/, '第 4 章重号这件事必须写出来，否则引用时指不清是哪一章');
  // 人物源文实测：35 处【旧版补充】块位置错乱 + 3 处断句残片
  const portrait = lf(fs.readFileSync(path.join(SKILLS, 'wanxiang-portrait', 'INDEX.md'), 'utf8'));
  assert.match(portrait, /【旧版补充】块位置错乱.*共 35 处/s, '补充块错位要如实说（读到"顺序怪"的内容时才知道为什么）');
  assert.match(portrait, /断句残片.*3 处/s, '断句残片要标出来，别让残片冒充原文');
});

test('SKILL.md 不得再出现被实测推翻的旧说法', () => {
  const design = readSkill('wanxiang-design');
  // 实测：16 个编号（第 4 章重号 → 17 个标题）、3.8 万字。旧文案写的 18 章 / 8.2 万字是错的。
  assert.ok(!/18\s*章/.test(design), '“18 章”与实测不符（实测 17 个章标题、16 个编号）');
  assert.ok(!/8\.2\s*万字/.test(design), '“8.2 万字”与实测不符（实测约 3.8 万字）');
  assert.ok(!/4\.7\s*万字/.test(design), '“4.7 万字”不是实测值');
  // 必须指向可读文本而不是那个二进制 docx
  assert.match(design, /wx_design_full\.txt/, '必须给出可 read 的抽取文本');
  assert.match(design, /INDEX\.md/, '必须指向章节索引（否则"读对应章节"没法执行）');
  const portrait = readSkill('wanxiang-portrait');
  assert.match(portrait, /INDEX\.md/, '必须指向章节索引');
  assert.match(portrait, /wx_full\.txt/);
});

test('抽取是加法：原文 docx 必须留在技能目录里，且 SKILL.md 说明它是原件', () => {
  let n = 0;
  for (const name of DIRS) {
    const files = treeOf(name).map(f => f.rel);
    const docx = files.filter(f => f.endsWith('.docx'));
    if (!docx.length) continue;
    n++;
    const raw = readSkill(name);
    for (const d of docx) {
      // 抽取文本方便 read，但逐字核对措辞时只能看原件——不能"只留 txt、丢了原文"。
      assert.ok(raw.includes(d), `${name}/${d} 还在目录里，SKILL.md 却没提它（要说明它是原件、什么时候才用）`);
    }
  }
  assert.ok(n >= 4, `只有 ${n} 个技能留了 docx 原件——检查逻辑是不是失效了`);
});
