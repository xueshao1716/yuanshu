// 真机事故回归（2026-09-18）：上传文件 → 该会话此后每一轮都 400
//   Upstream request failed: .messages[11]: You have uploaded an unsupported image.
//
// 根因链（不在元枢的组装层，所以看代码"没问题"）：
//   ① 上传路由给 **user** 消息落 {type:"file",name,path,size,mime:""}；
//   ② pi-ai/dist/api/openai-completions.js 处理用户消息 content 数组时只认 type==="text"，
//      其余一律写成 { type:"image_url", image_url:{ url:`data:${item.mimeType};base64,${item.data}` } }
//      → url = "data:;base64,undefined"；
//   ③ 上游按坏图拒绝 400。坏消息已经落盘，此后每轮重放都 400 → 会话作废。
//   ④ 纯文本模型不报错（transform-messages 的 downgradeUnsupportedImages 会先把图降级成占位文本），
//      所以只有 input 含 image 的模型才复现——真机复现脚本 D:\pi-workspace\tmp\repro-file-poison.mjs。
//
// 这个测试锁三件事：
//   ① 落盘的 user 块只允许 text / 真图（有 data+mimeType）；
//   ② 附件改写成文本标记后，界面照样能拿到文件卡片（extractFiles）；
//   ③ 已经躺在盘上的坏会话能被修回来（session-repair），且不碰 toolResult。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sdkSafeUserBlocks } from '../../engine/yuanshu-session.mjs';
import { attachmentText, filesFromText, stripAttachmentMarks, extractFiles, extractMessages } from '../../engine/session-utils.mjs';
import { initSessionFiles, getSessionList, invalidateSessionCache, findSession } from '../../engine/session-files.mjs';
import { repairSessionLine, repairSessionText, repairSessionFile } from '../../engine/session-repair.mjs';
import { formatSessionHistory } from '../../engine/unified-chat.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// 上游真正拒绝的是"用户消息里出现非 text 且非真图的块"——这就是 400 的充分条件
function unsafeUserBlock(b) {
  if (!b || typeof b !== 'object') return false;
  if (b.type === 'text') return false;
  if (b.type === 'image' && typeof b.data === 'string' && b.data && typeof b.mimeType === 'string' && b.mimeType) return false;
  return true;
}

test('用户消息落盘必须 SDK 安全：文件块改写成文本标记，真图保留', () => {
  const blocks = sdkSafeUserBlocks([
    { type: 'file', name: '顶级Skill-品牌级UI设计.md', path: '收发文件/2026-09-18/顶级Skill-品牌级UI设计.md', size: 7819, mime: '' },
    { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    { type: 'image', url: '/api/ws/file?path=x.png' },
    { type: 'video', url: '/v.mp4' },
    { type: 'text', text: '在吗' },
  ]);
  assert.equal(blocks.filter(unsafeUserBlock).length, 0, '用户消息里不许留非 text 块（会被写成 image_url: data:;base64,undefined → 400）');
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /^📎 附件: name="顶级Skill-品牌级UI设计\.md" path="收发文件\/2026-09-18\/顶级Skill-品牌级UI设计\.md" size=7819/);
  // 真图是 SDK 唯一支持的附件形态，必须原样留着（否则用户发的图模型就看不见了）
  assert.deepEqual(blocks[1], { type: 'image', data: 'AAAA', mimeType: 'image/png' });
  // 只有 url 的图（历史脏数据）降级成 markdown，不留在 content 里
  assert.equal(blocks[2].type, 'text');
  assert.match(blocks[2].text, /!\[图片\]\(\/api\/ws\/file\?path=x\.png\)/);
  assert.match(blocks[3].text, /\[视频\] \/v\.mp4/);
  assert.equal(blocks[4].text, '在吗');
  // 空输入也要给一个合法块
  assert.deepEqual(sdkSafeUserBlocks([]), [{ type: 'text', text: '' }]);
});

test('附件标记能还原成文件卡片：extractFiles 同时认文本标记与老 file 块', () => {
  const named = { name: '剧本.txt', path: '收发文件/2026-09-18/剧本.txt', size: 51676, mime: 'text/plain' };
  const marker = attachmentText(named);
  assert.deepEqual(filesFromText(`看下\n${marker}\n`), [named]);

  const content = [{ type: 'text', text: marker }];
  assert.deepEqual(extractFiles(content), [named]);
  // 老会话（file 块）继续认
  assert.deepEqual(extractFiles([{ type: 'file', name: 'a.txt', path: 'a.txt', size: 1, mime: '' }]), [{ name: 'a.txt', path: 'a.txt', size: 1, mime: '' }]);
  // 块 + 文本同时出现只算一次（否则界面会出现两张一样的卡片）
  assert.equal(extractFiles([{ type: 'file', ...named }, { type: 'text', text: marker }]).length, 1);
  // 字符串 content 也认
  assert.deepEqual(extractFiles(marker), [named]);
  // 名字里带引号也不能把标记写坏（上传已挡引号，这里兜底）
  assert.deepEqual(filesFromText(attachmentText({ name: 'a"b.txt', path: 'x/a"b.txt', size: 3 })), [{ name: "a'b.txt", path: "x/a'b.txt", size: 3, mime: '' }]);
});

test('界面文本不显示附件标记；模型侧历史仍能看到附件', () => {
  const marker = attachmentText({ name: '剧本.txt', path: '收发文件/2026-09-18/剧本.txt', size: 51676 });
  assert.equal(stripAttachmentMarks(`这个呢\n\n${marker}\n`), '这个呢');

  const entries = [{ type: 'message', id: 'u1', timestamp: '2026-09-18T06:19:07.686Z', message: { role: 'user', content: [{ type: 'text', text: marker }] } }];
  const msgs = extractMessages(entries, 'u1');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, '', '附件标记不能当正文显示（卡片负责呈现）');
  assert.equal(msgs[0].files.length, 1, '文件卡片必须还在');

  // 统一的元枢通道：历史重建时把附件还原成一行，且不再产出空 content 的用户消息
  const hist = formatSessionHistory([
    { role: 'user', text: '', files: [{ name: '剧本.txt', path: '收发文件/2026-09-18/剧本.txt', size: 51676, mime: '' }] },
    { role: 'user', text: '（空消息不该被发出去）', files: [] },
  ]);
  assert.match(hist[0].content, /📎 附件: name="剧本\.txt"/);
  assert.equal(hist[1].content, '（空消息不该被发出去）');
  assert.equal(formatSessionHistory([{ role: 'user', text: '', files: [] }]).length, 0, '空用户消息不许发（部分上游直接 400）');
});

test('存量坏会话能被修回来：user 附件块→文本标记，assistant 附件块→markdown，toolResult 不动', () => {
  const bad = [
    JSON.stringify({ type: 'session', id: 's1', cwd: 'D:\\pi-workspace' }),
    JSON.stringify({ type: 'message', id: 'u1', parentId: 's1', timestamp: '2026-09-18T06:19:07.686Z', message: { role: 'user', content: [{ type: 'file', name: 'file (1).png', path: '收发文件/2026-09-18/file (1).png', size: 1358424, mime: '' }] } }),
    JSON.stringify({ type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-09-18T06:19:08.000Z', message: { role: 'assistant', content: [{ type: 'image', url: '/api/ws/file?path=x.png' }] } }),
    JSON.stringify({ type: 'message', id: 't1', parentId: 'a1', timestamp: '2026-09-18T06:19:09.000Z', message: { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] } }),
    '',
  ].join('\n');

  const r1 = repairSessionText(bad);
  assert.equal(r1.changed, true);
  assert.equal(r1.repaired, 2, 'user 与 assistant 各一条要修');
  const lines = r1.text.split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.match(lines[1].message.content[0].text, /^📎 附件: name="file \(1\)\.png"/);
  assert.match(lines[2].message.content[0].text, /!\[图片\]\(\/api\/ws\/file\?path=x\.png\)/);
  assert.deepEqual(lines[3].message.content, [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }], 'toolResult 里的图是 SDK 支持的形态，不许动');
  assert.match(r1.text, /"type":"session"/, '非消息行必须原样保留');
  // 幂等：修完再修不该有变化（否则每次开会话都写盘）
  const r2 = repairSessionText(r1.text);
  assert.equal(r2.changed, false);
  assert.equal(r2.text, r1.text);
  // 干干净净的会话不会被碰（没有附件块 → 一行都不改）
  const clean = [
    JSON.stringify({ type: 'session', id: 's1' }),
    JSON.stringify({ type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: '你好' }] } }),
  ].join('\n');
  const r3 = repairSessionText(clean);
  assert.equal(r3.repaired, 0);
  assert.equal(r3.text, clean);
});

test('repairSessionFile 留备份且只改坏文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-repair-'));
  try {
    const badFile = path.join(dir, 'bad.jsonl');
    const goodFile = path.join(dir, 'good.jsonl');
    const badLine = JSON.stringify({ type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'file', name: 'a.txt', path: 'a.txt', size: 1, mime: '' }] } });
    fs.writeFileSync(badFile, badLine + '\n', 'utf8');
    const goodText = JSON.stringify({ type: 'message', id: 'u2', message: { role: 'user', content: [{ type: 'text', text: '你好' }] } }) + '\n';
    fs.writeFileSync(goodFile, goodText, 'utf8');

    const r = repairSessionFile(badFile);
    assert.equal(r.changed, true);
    assert.equal(r.repaired, 1);
    assert.ok(fs.existsSync(r.backup), '改之前必须留备份');
    assert.equal(fs.readFileSync(r.backup, 'utf8'), badLine + '\n');
    assert.match(fs.readFileSync(badFile, 'utf8'), /📎 附件:/);
    assert.equal(fs.readFileSync(goodFile, 'utf8'), goodText, '好文件不许被改写');
    // 幂等 + 备份不覆盖
    const r2 = repairSessionFile(badFile);
    assert.equal(r2.changed, false);
    assert.equal(fs.readFileSync(r.backup, 'utf8'), badLine + '\n', '备份必须保留最早那份');
    // 解析不了的行不许被吞（宁可原样留着，也不能毁用户数据）
    assert.deepEqual(repairSessionLine('{坏行'), { line: '{坏行', changed: false });
    assert.deepEqual(repairSessionLine(''), { line: '', changed: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('源码闸门：不许再往 user 消息里塞非 text 块（必须过 sdkSafeUserBlocks）', () => {
  const files = ['server.mjs', ...fs.readdirSync(path.join(ROOT, 'engine')).filter(f => f.endsWith('.mjs')).map(f => path.join('engine', f))];
  const offenders = [];
  for (const rel of files) {
    if (rel.endsWith('session-repair.mjs') || rel.endsWith('yuanshu-session.mjs')) continue; // 修复器与安全化器自己就是干这个的
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/role:\s*"user"/.test(lines[i])) continue;
      const window = lines.slice(i, i + 3).join(' ');
      if (!/type:\s*"(file|image|video|audio)"/.test(window)) continue;
      if (window.includes('sdkSafeUserBlocks')) continue;
      offenders.push(`${rel}:${i + 1}`);
    }
  }
  assert.deepEqual(offenders, [], `这些地方往 user 消息里写了附件块，会把整个会话毒成 400：${offenders.join(', ')}`);
});

test('会话列表缓存自愈：懒落盘的新会话必须能被按 id 查到（否则前端拉消息 404 → 卡片不显示）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-sessions-'))
  const dir = path.join(root, '--D--pi-workspace--')
  fs.mkdirSync(dir, { recursive: true })
  try {
    initSessionFiles({ sessionsDir: dir, workspaceCwd: 'D:\\pi-workspace' })
    invalidateSessionCache()
    // 先建好缓存（此刻还没有文件）——真实场景：新建会话后前端立刻刷新列表，但 SDK 还没落盘
    const before = getSessionList();
    const file = path.join(dir, '2026-09-18T07-03-53-379Z_01a0b354-test.jsonl')
    const sid = '01a0b354-2d23-70d3-b172-29df5a2e406d'
    // 之后文件才真正出现（appendMessage 触发 flush）
    fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: sid, timestamp: '2026-09-18T07:03:53.379Z', cwd: 'D:\\pi-workspace' }) + '\n'
      + JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: [attachmentText({ name: 'a.txt', path: '收发文件/2026-09-18/a.txt', size: 3 })] } }) + '\n', 'utf8');
    assert.equal(before.some(s => s.id === sid), false, '前置条件：缓存建立时还没有这个会话');
    assert.equal(getSessionList().some(s => s.id === sid), false, '缓存不失效的话就是查不到（这正是真机 404 的成因）');
    const found = findSession(sid);
    assert.ok(found && found.id === sid, 'findSession 必须自愈：缓存没有就重扫一次');
    assert.equal(findSession('不存在的会话'), null);
    assert.equal(findSession(''), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    invalidateSessionCache();
  }
});

test('界面闸门：上传必须带真实 sessionId；新建会话必须先切会话再刷新列表', () => {
  const send = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'components', 'SendBox.tsx'), 'utf8');
  // 上传不许再出现"拿不到 id 就发空 id"的写法（服务端一猜，卡片就落到别的会话）
  assert.match(send, /ensureSession/, 'SendBox 必须能在会话未就绪时向宿主索要一个真实会话 id');
  assert.match(send, /const d = await WsApi\.upload\(f\.name, btoa\(bin\), sid \|\| undefined\)/, '上传必须带上解析后的会话 id');
  assert.match(send, /guessedSession/, '服务端说"这次是猜的"时前端要能拿到并如实提示');

  const chat = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'components', 'ChatArea.tsx'), 'utf8');
  // 真机 bug 的根：`await refreshSessions()` 挡在 selectSession 前面 → currentSessionId 空几秒 → 上传裸奔
  assert.equal(/await refreshSessions\(\);\s*selectSession\(/.test(chat), false, 'ChatArea 里不许再让 refreshSessions 挡在 selectSession 前面（会让会话切换晚几秒）');
  assert.match(chat, /ensureSession=\{ensureSessionId\}/, 'ChatArea 必须把 ensureSession 传给 SendBox');
  assert.match(chat, /const ensureSessionId = useCallback/, 'ensureSessionId 必须真的实现');

  const sidebar = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'components', 'Sidebar.tsx'), 'utf8');
  assert.equal(/await refreshSessions\(\);\s*selectSession\(/.test(sidebar), false, 'Sidebar 新建会话同样不许让刷新挡在切换前面');
});
