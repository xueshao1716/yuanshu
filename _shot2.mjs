import { chromium } from 'playwright';
const ctx = await chromium.launchPersistentContext('D:/tmp/prof', {
  channel: 'chrome', headless: true, viewport: { width: 1512, height: 950 }, deviceScaleFactor: 2,
});
const pages = ctx.pages();
const p = pages[0] || await ctx.newPage();
await p.goto('http://127.0.0.1:8787', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e=>console.log('goto:', e.message));
await p.waitForTimeout(6000);
console.log('URL=' + p.url());
const keys = await p.evaluate(() => Object.keys(localStorage));
console.log('KEYS=' + keys.join(','));
console.log('BODY=' + (await p.innerText('body').catch(()=>'')).slice(0,200).replace(/\s+/g,' '));
await p.screenshot({ path: 'D:/tmp/wb2.png' });
await ctx.close();
