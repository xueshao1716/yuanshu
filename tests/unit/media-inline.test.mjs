// 连续创作「参考图上送」契约（2026-09-15）
//
// 真实故障：Agnes 视频接口只接受**公网 http(s) URL 或 base64 data URI**，
// 而元枢把角色定妆照以 `/api/ws/file?path=...`（自己的相对地址）塞进 images[]，
// 于是每次带参考图的任务都是：
//   视频任务创建失败 400: {"code":"invalid_request","message":"media must be a public http(s) URL
//   or base64 data. Local file paths are not supported; upload the file first ..."}
// 真实项目「制作台验收」里 5 次视频运行全是这一条。本文件锁住修复后的行为。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  materializeMedia, materializeVideoBody, isDirectMedia, resolveLocalMedia, mimeFor,
  MEDIA_MAX_BYTES, MEDIA_KEYS,
} from '../../engine/media/inline.mjs';
import { localPathFromArtifactUrl } from '../../engine/story/film.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-media-inline-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const wsRoot = tmp;
const png = path.join(tmp, '生成物', '图片', 'a.png');
fs.mkdirSync(path.dirname(png), { recursive: true });
fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
const urlFor = (abs) => `/api/ws/file?path=${encodeURIComponent(path.relative(wsRoot, abs))}`;

test('公网 http(s) 与 data URI 原样放过，不做无谓的读取和转码', () => {
  for (const v of ['https://cdn.example.com/a.png', 'http://x/a.jpg', 'data:image/png;base64,AAAA']) {
    assert.equal(isDirectMedia(v), true);
    assert.deepEqual(materializeMedia(v, { wsRoot }), { value: v, note: '' });
  }
  // 相对地址与裸路径都不是"上游能直接用"的形式
  assert.equal(isDirectMedia('/api/ws/file?path=a.png'), false);
  assert.equal(isDirectMedia('D:\\x\\a.png'), false);
});

test('元枢自己的文件地址被内联成 base64 data URI，带正确的 MIME', () => {
  const url = urlFor(png);
  assert.equal(resolveLocalMedia(url, wsRoot), png, '签名/未签名地址都要能解出磁盘路径');
  const r = materializeMedia(url, { wsRoot });
  assert.equal(r.note, '');
  assert.match(r.value, /^data:image\/png;base64,/);
  assert.equal(Buffer.from(r.value.split(',')[1], 'base64').length, 8, '内联内容必须与源文件逐字节一致');
  // 裸的绝对路径同样处理（用户可能直接粘了本机路径）
  assert.match(materializeMedia(png, { wsRoot }).value, /^data:image\/png;base64,/);
});

test('MIME 按扩展名判定，未知扩展名不装作是图片', () => {
  assert.equal(mimeFor('a.PNG'), 'image/png');
  assert.equal(mimeFor('a.mp4'), 'video/mp4');
  assert.equal(mimeFor('a.xyz'), 'application/octet-stream');
});

// 这两条是探针里真踩到的坑，不是假想：
//  - 没有 wsRoot 时 story-film 的 withinRoot 会放行任意路径，按 CWD 解析可能读到工作区外的文件
//  - 解不出来的 `/api/ws/file?...` 被 path.resolve 拼成 <wsRoot>\api\ws\file?...，
//    报出来的却是"文件不存在"，把排查方向带偏
test('解析不到的 URL 形态引用要明确说"解析不到"，不能拼成荒谬路径还报"文件不存在"', () => {
  assert.equal(resolveLocalMedia('/api/ws/file?path=x.png'), '', '没有 wsRoot 就不该猜路径');
  const noRoot = materializeMedia('/api/ws/file?path=x.png', { wsRoot: '' });
  assert.equal(noRoot.value, '');
  assert.match(noRoot.note, /解析不到本地路径/);
  assert.doesNotMatch(noRoot.note, /不存在或读不到/, '把"没解析出来"说成"文件不存在"会把人带偏');

  // 工作区之外的绝对路径：withinRoot 不放行，同样如实拒绝
  const outside = materializeMedia(path.join(os.tmpdir(), '..', 'not-in-ws.png'), { wsRoot: path.join(tmp, '生成物') });
  assert.equal(outside.value, '');
  assert.ok(outside.note.length > 0);
});

test('落不下来的参考图被摘掉，并留下一句人话原因', () => {
  const missing = materializeMedia(urlFor(path.join(tmp, '生成物', '图片', '没有这个.png')), { wsRoot });
  assert.equal(missing.value, '');
  assert.match(missing.note, /不存在或读不到/);

  const empty = path.join(tmp, 'empty.png');
  fs.writeFileSync(empty, '');
  assert.match(materializeMedia(empty, { wsRoot }).note, /空文件/);

  const big = path.join(tmp, 'big.png');
  fs.writeFileSync(big, Buffer.alloc(MEDIA_MAX_BYTES + 1));
  const r = materializeMedia(big, { wsRoot });
  assert.equal(r.value, '', '超过上限绝不能塞进请求体');
  assert.match(r.note, /超过 8MB 内联上限/);
  assert.match(r.note, /big\.png/, '原因里要点名是哪个文件，否则用户不知道该换哪张');
});

test('materializeVideoBody：数组与标量都落地，落空的项从请求里消失', () => {
  const ok = materializeVideoBody(
    { model: 'agnes-video-2.5-flash', mode: 'reference', images: [urlFor(png), 'https://cdn.example.com/b.png'] },
    { wsRoot },
  );
  assert.equal(ok.body.images.length, 2);
  assert.match(ok.body.images[0], /^data:image\/png;base64,/);
  assert.equal(ok.body.images[1], 'https://cdn.example.com/b.png', '本来就能用的地址不该被改写');
  assert.equal(ok.body.mode, 'reference', '参考图还在，mode 不该被动');
  assert.deepEqual(ok.notes, []);
});

test('参考图全被摘掉时 mode 要跟着降级，不能发一个没有 media 的 reference 请求', () => {
  const bad = materializeVideoBody(
    { model: 'x', mode: 'reference', images: ['/api/ws/file?path=%E6%B2%A1%E6%9C%89.png'] },
    { wsRoot },
  );
  assert.equal('images' in bad.body, false, '落不下来的项必须从请求里摘掉');
  assert.equal(bad.body.mode, 'text', '摘掉参考图后还写 reference，上游会收到一个空 reference 请求');
  assert.equal(bad.notes.length, 1);

  const kf = materializeVideoBody({ model: 'x', mode: 'keyframe', first_frame: '/api/ws/file?path=nope.png' }, { wsRoot });
  assert.equal(kf.body.mode, 'text');
  assert.equal('first_frame' in kf.body, false);
});

test('MEDIA_KEYS 必须覆盖 video-request 会转发的全部 media 字段', () => {
  const src = fs.readFileSync(new URL('../../engine/video-request.mjs', import.meta.url), 'utf8');
  for (const key of MEDIA_KEYS) assert.ok(src.includes(`src.${key}`), `video-request 转发了 ${key}，落地清单里不能漏`);
});

test('localPathFromArtifactUrl 是复用的那一份实现，不是又抄了一遍解析', () => {
  const src = fs.readFileSync(new URL('../../engine/media/inline.mjs', import.meta.url), 'utf8');
  // 2026-11-06：story 已迁到 engine/story/，引用形式随之变化
  assert.match(src, /from '\.\.\/story\/film\.mjs'/, '同一个解析规则只该有一份，抄第二份就会各自漂移');
  assert.equal(localPathFromArtifactUrl(urlFor(png), wsRoot), png);
});

// 出口契约：这两个函数是元枢把 media 交给上游的**仅有的两条路**，
// 谁把落地那一步漏掉，同样的 400 就会从另一条路回来。
test('upstream 出口必须都做 media 落地：视频创建体与图像参考图', () => {
  const src = fs.readFileSync(new URL('../../engine/media/api.mjs', import.meta.url), 'utf8');
  const start = src.slice(src.indexOf('export async function startVideoJob'), src.indexOf('export async function checkVideoJob'));
  assert.match(start, /materializeVideoBody\(/, '视频创建体必须先落地再 POST —— 直接把元枢地址发出去就是那个 400');
  const img = src.slice(src.indexOf('export async function generateImage'), src.indexOf('export async function handleImage'));
  assert.match(img, /materializeMedia\(/, '图生图的参考图同样只认公网地址或 base64');
  // 摘掉参考图的原因要跟着结果回去，不能在返回途中丢掉
  const gen = src.slice(src.indexOf('export async function generateVideo'), src.indexOf('// POST /api/media'));
  assert.match(gen, /notes/, 'generateVideo 必须把创建阶段的 notes 一路带回适配器');
});
