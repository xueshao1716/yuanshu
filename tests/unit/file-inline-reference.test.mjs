// 外部机器安装检查的第 4 个 bug：@文件引用把二进制文件的字节内联进 prompt。
// xlsx/docx/pdf/zip/图片拼进去就是乱码——费 token、污染对话，模型还照着乱码猜内容。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { referenceExt, looksBinaryContent, isBinaryReference, binaryReferenceNote } from '../../engine/file-inline.mjs';

test('二进制扩展名不内联；文本扩展名绝对不能误判', () => {
  for (const p of ['a.xlsx', 'b.XLSM', 'c.docx', 'd.pdf', 'e.zip', 'f.png', 'g.mp3', 'h.mp4', 'i.ttf', 'j.sqlite', 'k.apk']) {
    assert.equal(isBinaryReference({ path: p, content: 'x' }), true, `${p} 应判为二进制`);
  }
  // 误判比乱码更糟：模型会以为文件是空的，然后开始编
  for (const p of ['a.txt', 'b.md', 'c.json', 'd.csv', 'e.svg', 'f.mjs', 'g.html', 'h.log', 'i.yml', 'j.xml']) {
    assert.equal(isBinaryReference({ path: p, content: '这是正常文本，有中文和符号。' }), false, `${p} 不能误判`);
  }
  assert.equal(referenceExt('C:\\a\\b\\报告.docx'), 'docx');
  assert.equal(referenceExt('noext'), '');
  assert.equal(referenceExt('trailing.'), '');
});

test('扩展名看不出来时靠内容嗅探（被改名成 txt 的二进制也要挡住）', () => {
  assert.equal(looksBinaryContent('PK\u0003\u0004\u0000\u0000binary'), true);
  assert.equal(looksBinaryContent('正常的 UTF-8 中文，带换行\n和制表\t和回车\r'), false);
  assert.equal(looksBinaryContent(''), false);
  assert.equal(isBinaryReference({ path: 'renamed.txt', content: 'PK\u0003\u0004\u0000\u0000xxxx' }), true);
  assert.equal(isBinaryReference({ path: 'renamed.txt', content: '一切正常的文本内容' }), false);
});

test('不内联之后要给出可执行的下一步，而不是让模型瞎猜', () => {
  const note = binaryReferenceNote('D:\\x\\报表.xlsx');
  assert.match(note, /二进制文件/);
  assert.match(note, /\/api\/parse-file/, '要指明用哪个接口解析');
  assert.match(note, /不要凭空猜测/);
});

test('server.mjs 必须在"内联字节"那一行之前挡住二进制（源码契约）', () => {
  const srv = fs.readFileSync('server.mjs', 'utf8');
  assert.match(srv, /import \{ isBinaryReference, binaryReferenceNote \} from "\.\/engine\/file-inline\.mjs"/);
  const idxBin = srv.indexOf('if (isBinaryReference(f)) {');
  const idxPush = srv.indexOf('parts.push(`参考文件 ${f.path}：');
  assert.ok(idxBin > 0, '要真的调用判定');
  assert.ok(idxPush > 0 && idxBin < idxPush, '判定必须在内联之前，否则等于没修');
});
