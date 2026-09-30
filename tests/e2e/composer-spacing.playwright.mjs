import assert from 'node:assert/strict';
import test from 'node:test';
import { setup, reachable } from './fixtures/composer-gallery-server.mjs';
for (const width of [1440, 390]) test(`composer primary actions remain separated at ${width}px`, async t => {
  const {page,input,errors} = await setup(t,width);
  await input.fill('隔离布局检查');
  const send = page.getByRole('button',{name:'发送消息',exact:true});
  const call = page.getByRole('button',{name:'语音通话',exact:true});
  await send.waitFor();
  const s = await send.boundingBox(), c = await call.boundingBox();
  assert.ok(s && c && s.x - (c.x+c.width) >= 8, 'call and send need at least 8px separation');
  assert.ok(await reachable(send)); assert.ok(await reachable(call));
  const model = await page.locator('[data-slot="model-trigger"]').boundingBox();
  assert.ok(model?.width >= 96, 'model chooser keeps useful width');
  if(width<900) assert.ok(s.height>=44 && c.height>=44);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:`tmp/composer-spacing-${width}.png`});
  assert.deepEqual(errors,[]);
});
