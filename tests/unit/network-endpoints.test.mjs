import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('deployment endpoints come from local configuration without public defaults', async () => {
  const { resolveShareOrigin, voiceAllowedOrigins } = await import('../../engine/network-endpoints.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-endpoints-'));
  try {
    assert.equal(resolveShareOrigin({ host: '', agentDir: root }), '');
    fs.writeFileSync(path.join(root, 'system-network.json'), JSON.stringify({ domains: [
      { domain: 'chat.example.test', desc: '工作台主入口' },
      { domain: 'share.example.test', desc: '外网分享' },
    ] }));
    assert.equal(resolveShareOrigin({ host: '', agentDir: root }), 'https://share.example.test');
    assert.equal(resolveShareOrigin({ host: 'https://public.example.test', agentDir: root }), 'https://public.example.test');
    for (const host of ['https://user:secret@example.test', 'https://example.test/path', 'javascript:alert(1)', 'https://example.test/?token=secret']) {
      assert.equal(resolveShareOrigin({ host, agentDir: root }), '', 'reject malformed explicit host');
    }
    const origins = voiceAllowedOrigins({ agentDir: root, configured: 'https://other.example.test, *', port: 9000 });
    assert.ok(origins.includes('https://chat.example.test'));
    assert.ok(origins.includes('https://other.example.test'));
    assert.ok(origins.includes('http://127.0.0.1:9000'));
    assert.equal(origins.includes('*'), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
