// 验证新 server 架构 - 冒烟测试
// 检查：1) 能否启动  2) 基础路由是否响应  3) 是否有明显错误

import http from 'node:http';

const BASE_URL = 'http://127.0.0.1:8787';
const TOKEN = 'test-token'; // 需要从 .token 文件读取真实 token

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    return true;
  } catch (err) {
    console.error(`❌ ${name}: ${err.message}`);
    return false;
  }
}

async function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({ status: res.statusCode, data, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function main() {
  console.log('🔍 验证新 server 架构...\n');

  let passed = 0;
  let failed = 0;

  // 1. 静态文件（无需鉴权）
  if (await test('GET / 返回 HTML', async () => {
    const res = await fetch(BASE_URL + '/');
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    if (!res.data.includes('html')) throw new Error('不是 HTML');
  })) passed++; else failed++;

  // 2. API 鉴权（无 token 应该 401）
  if (await test('GET /api/models 无 token 返回 401', async () => {
    const res = await fetch(BASE_URL + '/api/models');
    if (res.status !== 401) throw new Error(`status ${res.status}, 期望 401`);
  })) passed++; else failed++;

  // 3. API 鉴权（有 token 应该通过）
  if (await test('GET /api/models 有 token 返回 200', async () => {
    const res = await fetch(BASE_URL + '/api/models', {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    if (res.status !== 200) throw new Error(`status ${res.status}`);
  })) passed++; else failed++;

  // 4. CORS
  if (await test('OPTIONS /api/models 返回 204', async () => {
    const res = await fetch(BASE_URL + '/api/models', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:3000' }
    });
    if (res.status !== 204) throw new Error(`status ${res.status}`);
    if (!res.headers['access-control-allow-origin']) throw new Error('缺少 CORS 头');
  })) passed++; else failed++;

  // 5. 404
  if (await test('GET /api/nonexistent 返回 404', async () => {
    const res = await fetch(BASE_URL + '/api/nonexistent', {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    if (res.status !== 404) throw new Error(`status ${res.status}, 期望 404`);
  })) passed++; else failed++;

  console.log(`\n📊 结果: ${passed} 通过, ${failed} 失败`);
  
  if (failed === 0) {
    console.log('✅ 新架构基础功能正常');
    process.exit(0);
  } else {
    console.log('❌ 新架构存在问题，需要修复');
    process.exit(1);
  }
}

main();
