// Browser acceptance against isolated build + fixtures. Never reach production APIs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {knowledgeFixture} from './knowledge-fixture.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = path.resolve(root, process.env.YUANSHU_TEST_DIST || 'tmp/verification-dist');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(dist, pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1)));
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {res.writeHead(404); return res.end();}
  res.writeHead(200, {'Content-Type': {'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.extname(file)] || 'application/octet-stream'});
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({headless: true, ...(process.env.YUANSHU_CHROME_PATH ? {executablePath: process.env.YUANSHU_CHROME_PATH} : {})});
  for (const width of [1440, 390]) {
    const context = await browser.newContext({viewport: {width, height: 900}}), page = await context.newPage();
    const state = knowledgeFixture(), errors = [];
    page.setDefaultTimeout(10000);
    page.on('pageerror', e => errors.push(e.message));
    await page.routeWebSocket('**/*', ws => ws.close());
    await page.route('**/*', route => {
      const u = new URL(route.request().url());
      if (u.origin !== origin) return route.abort();
      return u.pathname.startsWith('/api/') ? state.respond(route) : route.continue();
    });
    await page.addInitScript(() => {
      localStorage.setItem('yuanshu_access_token', 'isolated-knowledge-test');
      localStorage.setItem('pi_last_session', 'fixture');
      localStorage.setItem('yuanshu_companion_hidden', 'true');
    });
    await page.goto(origin + '/#/apps');
    const panel = page.getByRole('region', {name: '知识自动积累', exact: true});
    const jobs = panel.getByRole('region', {name: '知识任务', exact: true});
    const click = name => panel.getByRole('button', {name, exact: true}).click();
    const fit = async label => {
      const sizes = await panel.evaluate(el => ({client: el.clientWidth, scroll: el.scrollWidth, doc: document.documentElement.scrollWidth, width: innerWidth}));
      assert.ok(sizes.scroll <= sizes.client + 1 && sizes.doc <= sizes.width + 1, `${width}/${label} overflow: ${JSON.stringify(sizes)}`);
    };
    await jobs.getByText(/暂无知识任务/).waitFor();
    state.intakeError = 'knowledge_storage_full';
    await click('刷新状态');
    await panel.getByText(/资料登记未完成/).waitFor();
    await panel.locator('summary').filter({hasText: '授权与用量设置'}).click();
    await panel.getByText(/模型目录读取失败/).waitFor();
    await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/api/knowledge/models' && r.status() === 503), click('重试读取')]);
    state.failModels = false;
    await click('重试读取');
    const roots = panel.getByRole('textbox', {name: '允许读取的目录（相对工作空间，一行一个）', exact: true});
    await roots.fill('docs/尚未保存的草稿');
    state.policy = {...state.policy, revision: 2, allowedRoots: ['docs/current']};
    await click('刷新状态');
    await panel.getByText(/设置已在别处更新/).waitFor();
    assert.equal(await roots.inputValue(), 'docs/尚未保存的草稿');
    assert.equal(await panel.getByRole('button', {name: '保存授权与限额', exact: true}).isDisabled(), true);
    await click('重新载入最新设置（放弃当前草稿）');
    assert.equal(await roots.inputValue(), 'docs/current');
    await fit('policy');
    state.failReads = true;
    await click('保存授权与限额');
    await panel.getByRole('button', {name: '保存授权与限额', exact: true}).waitFor();
    assert.equal(await panel.getByRole('button', {name: '保存授权与限额', exact: true}).isEnabled(), true);
    // Save succeeded but its refetch failed: load the new revision before a new mutation.
    state.failReads = false;
    await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/api/knowledge/policy' && r.status() === 200), click('刷新状态')]);
    state.failReads = true;
    await click('暂停自动处理');
    await panel.getByRole('button', {name: '暂停自动处理', exact: true}).waitFor();
    assert.equal(await panel.getByRole('button', {name: '暂停自动处理', exact: true}).isEnabled(), true);
    await click('刷新队列');
    await page.getByRole('region', {name: '日常积累', exact: true}).getByRole('button', {name: '刷新记录', exact: true}).click();
    await page.getByText(/经验库读取失败，请刷新重试/).waitFor();
    state.failReads = false;
    await click('刷新状态');
    await panel.getByRole('button', {name: '恢复自动处理', exact: true}).waitFor();
    await panel.locator('summary').filter({hasText: '授权与用量设置'}).click();
    const source = panel.locator('details').filter({has: page.locator('summary').filter({hasText: /^补充一份来源$/})});
    await source.locator('summary').click();
    await source.getByRole('textbox', {name: '相对工作空间的文件路径', exact: true}).fill('docs/file.txt');
    await source.getByRole('button', {name: '提交到知识队列', exact: true}).click();
    await source.getByRole('alert').filter({hasText: '来源尚未授权'}).waitFor();
    state.denySource = false;
    await source.getByRole('button', {name: '提交到知识队列', exact: true}).click();
    await source.getByRole('status').filter({hasText: '已登记：新登记来源'}).waitFor();
    await source.locator('summary').click();
    state.jobs = Array.from({length: 21}, (_, i) => state.job(i));
    state.jobs[0] = state.job(0, {title: '极长资料标题'.repeat(30), state: 'review_required', stage: 'validating', reason: 'correction_requires_review',
      sources: [{kind: 'file', path: 'docs/' + 'long-source-'.repeat(40) + '.txt'}], validation: {reason: 'correction_requires_review', entry: {text: '核对原始来源中的资料', verified: false, scope: '测试环境'}}});
    await click('刷新队列');
    await jobs.getByText('第 1 / 2 页', {exact: true}).waitFor();
    await jobs.getByRole('button', {name: '下一页', exact: true}).click();
    await jobs.getByText('第 2 / 2 页', {exact: true}).waitFor();
    await jobs.getByRole('button', {name: '上一页', exact: true}).click();
    await jobs.getByRole('button', {name: new RegExp('^极长资料标题')}).click();
    await jobs.locator('summary').filter({hasText: '人工核对并裁决'}).click();
    const submit = jobs.getByRole('button', {name: '记录人工裁决', exact: true});
    assert.equal(await submit.isDisabled(), true);
    await jobs.getByRole('textbox', {name: '核对依据与选择理由', exact: true}).fill('已核对夹具来源，仅选择可引用来源');
    await jobs.getByRole('checkbox', {name: '我已核对原始来源，确认本次选择', exact: true}).check();
    await fit('long-detail');
    const small = await panel.locator('button, summary, select').evaluateAll(nodes => nodes.filter(n => n.getBoundingClientRect().height > 0 && n.getBoundingClientRect().height < 43).map(n => ({text: n.textContent, height: n.getBoundingClientRect().height})));
    assert.deepEqual(small, [], 'new controls must provide 44px touch targets');
    await page.screenshot({path: path.join(root, `tmp/knowledge-${width}.png`), fullPage: true});
    await submit.click();
    await jobs.getByRole('button', {name: new RegExp('^极长资料标题.*排队中')}).waitFor();
    const review = state.writes.find(w => w.path.endsWith('/review'));
    assert.equal(review.data.revision, 1); assert.equal(review.data.policyRevision, state.policy.revision);
    assert.equal(review.data.confirmed, true);
    state.failReads = true;
    await jobs.getByRole('button', {name: '暂停任务', exact: true}).click();
    await jobs.getByRole('alert').filter({hasText: /知识服务暂不可用/}).waitFor();
    assert.equal(state.jobs[0].state, 'paused');
    assert.equal(await jobs.getByRole('button', {name: '暂停任务', exact: true}).isEnabled(), true);
    state.failReads = false;
    await click('刷新队列');
    await jobs.getByRole('button', {name: '继续任务', exact: true}).click();
    await jobs.getByRole('button', {name: '暂停任务', exact: true}).waitFor();
    // A resolved parent keeps its audit state, but is no longer an actionable review.
    state.jobs[0] = {...state.jobs[0], state: 'review_required', displayState: 'resolved',
      resolution: {jobId: 'supplement-fixture', entryId: 'resolved-entry-fixture', at: 1790762400000}};
    await click('刷新队列');
    await jobs.getByRole('button', {name: new RegExp('^极长资料标题.*已由补证解决')}).waitFor();
    await jobs.getByText(/supplement-f/).waitFor();
    await jobs.getByText(/resolved-ent/).waitFor();
    assert.equal(await jobs.locator('summary').filter({hasText: '人工核对并裁决'}).count(), 0);
    assert.equal(await jobs.getByRole('button', {name: '记录人工裁决', exact: true}).count(), 0);
    assert.equal(await jobs.getByRole('button', {name: '暂停任务', exact: true}).count(), 0);
    assert.equal(await jobs.getByRole('button', {name: '取消任务', exact: true}).count(), 0);
    await fit('resolved-detail');
    state.jobs[1]=state.job(1,{state:'committed',stage:'committed',entryId:'original-entry',title:'已入库的旧结论'});
    await click('刷新队列');
    await jobs.getByRole('button',{name:/已入库的旧结论/}).click();
    await jobs.locator('summary').filter({hasText:'更正这条已入库知识'}).click();
    await jobs.getByText(/通过核查前，原条目不被替换/).waitFor();
    const correction=jobs.getByRole('textbox',{name:'相对工作空间的文件路径',exact:true});
    await correction.fill('docs/correction.txt');
    await jobs.getByRole('button',{name:/隔离资料 2/}).click();
    assert.equal(await jobs.locator('summary').filter({hasText:'更正这条已入库知识'}).count(),0);
    await jobs.getByRole('button',{name:/已入库的旧结论/}).click();
    await jobs.locator('summary').filter({hasText:'更正这条已入库知识'}).click();
    assert.equal(await correction.inputValue(),'','correction draft must not cross knowledge records');
    assert.equal(state.writes.filter(w=>w.path.endsWith('/supplement')).length,0);
    await fit('committed-correction');
    await page.screenshot({path:path.join(root,`tmp/knowledge-correction-${width}.png`),fullPage:true});
    await page.clock.install();
    await page.goto(origin + '/#/chat');
    await page.waitForTimeout(200);
    const inactive = [...state.counts].filter(([p]) => p.startsWith('/api/knowledge/'));
    await page.clock.runFor(95000);
    await page.waitForTimeout(100);
    for (const [p, n] of inactive) assert.equal(state.counts.get(p), n, `${p} continued polling off-page`);
    assert.deepEqual(errors, []);
    console.log(`${width}px passed: empty/error, preserved draft, failed refresh release, source, pagination, review, resolved history, touch/layout, inactive polling`);
    await context.close();
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
