import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 手机壳页面是 https://localhost，电脑地址是局域网 http://IP:8787；<img>/<video> 不走 CapacitorHttp，
// allowMixedContent:false 会让资产页所有图片/视频被 WebView 拦截（2026-10-14 真机：资产全是空白）。
test('Android 壳必须允许混合内容，否则 http 局域网地址的图片视频全部加载失败', () => {
  assert.match(fs.readFileSync(new URL('../../capacitor.config.ts', import.meta.url), 'utf8'), /allowMixedContent:\s*true/);
  const synced = new URL('../../android/app/src/main/assets/capacitor.config.json', import.meta.url);
  if (fs.existsSync(synced)) assert.equal(JSON.parse(fs.readFileSync(synced, 'utf8')).android.allowMixedContent, true);
});
