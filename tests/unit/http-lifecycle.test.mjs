import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { serveProductionCallback } from './server-route-lifetime.test.mjs';

const headers = { Authorization: 'Bearer route-test-token' };

test('unexpected errors hide internal details and carry request correlation', async t => {
  const base = await serveProductionCallback(t, [['GET', '/probe', () => { throw new Error('private-path/credentials.json'); }]]);
  const response = await fetch(base + '/probe', { headers });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error, '内部服务错误，请凭请求编号查看服务日志');
  assert.equal(body.requestId, response.headers.get('x-request-id'));
});

test('invalid thrown statuses become safe 500 responses', async t => {
  for (const statusCode of [200, 302, 799, 401.5, 'garbage']) {
    const base = await serveProductionCallback(t, [['GET', '/probe', () => { throw Object.assign(new Error('private-detail'), { statusCode }); }]]);
    const response = await fetch(base + '/probe', { headers, signal: AbortSignal.timeout(1500) });
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /private-detail/);
  }
});

test('intentional client errors retain status and actionable message', async t => {
  const base = await serveProductionCallback(t, [['GET', '/probe', () => { throw Object.assign(new Error('请求体过大'), { statusCode: 413 }); }]]);
  const response = await fetch(base + '/probe', { headers });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error, '请求体过大');
});

test('stream failure closes transport instead of leaving a hanging successful response', async t => {
  let fail;
  const gate = new Promise(resolve => { fail = resolve; });
  const base = await serveProductionCallback(t, [['GET', '/probe', async res => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: started\n\n');
    await gate;
    throw new Error('stream failed');
  }]]);
  const response = await fetch(base + '/probe', { headers, signal: AbortSignal.timeout(1500) });
  const reader = response.body.getReader();
  await reader.read();
  fail();
  const result = await Promise.race([reader.read().then(() => 'ended', () => 'aborted'), delay(300).then(() => 'hung')]);
  assert.equal(result, 'aborted');
});

test('request completion logs wait for finish and exclude queries', async t => {
  const logs = [];
  let finish;
  const base = await serveProductionCallback(t, [['GET', '/probe', res => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: started\n\n');
    finish = () => res.end();
  }]], { console: { log: text => logs.push(text) } });
  const response = await fetch(base + '/probe?token=secret-query', { headers });
  assert.equal(logs.length, 0, 'returning from handler is not completion');
  finish();
  await response.text();
  await delay(10);
  assert.equal(logs.length, 1);
  const entry = JSON.parse(logs[0]);
  assert.equal(entry.event, 'http_request');
  assert.equal(entry.outcome, 'finished');
  assert.equal(entry.path, '/probe');
  assert.doesNotMatch(logs[0], /secret-query/);
});

test('client disconnection logs one aborted outcome', async t => {
  const logs = [];
  const base = await serveProductionCallback(t, [['GET', '/probe', res => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: started\n\n');
  }]], { console: { log: text => logs.push(text) } });
  const abort = new AbortController();
  const response = await fetch(base + '/probe', { headers, signal: abort.signal });
  await response.body.getReader().read();
  abort.abort();
  for (let i = 0; i < 30 && !logs.some(line => line.includes('aborted')); i++) await delay(10);
  assert.equal(logs.length, 1);
  assert.equal(JSON.parse(logs[0]).outcome, 'aborted');
});

test('asynchronous static failures use the same error boundary', async t => {
  const logs = [];
  const base = await serveProductionCallback(t, [], {
    reactStatic: { async handle() { throw new Error('internal static path'); } },
    console: { log: line => logs.push(line) },
  });
  const response = await fetch(base + '/', { signal: AbortSignal.timeout(1500) });
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /internal static path/);
  await delay(10);
  assert.equal(JSON.parse(logs[0]).outcome, 'failed');
});

test('explicit client error credentials remain redacted', async t => {
  const base = await serveProductionCallback(t, [['GET', '/probe', () => {
    throw Object.assign(new Error('invalid api_key=private-secret'), { statusCode: 400 });
  }]]);
  const response = await fetch(base + '/probe', { headers });
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), /private-secret/);
});
