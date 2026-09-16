// 2026-09-16 视觉整理收尾（用户原话：「页面也再美化下，不好看」）。
// 这里锁的两件事都是"活着才看得见"的：掉一个 import、少一个 loading 落位，
// 页面照样能跑，但用户看到的就是"我故事没了"或者"形象和重新生成混在一行"。
// 所以用源码断言钉住意图，而不是等哪天有人截图才发现。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workbench = fs.readFileSync('frontend/src/pages/StoryWorkbench.tsx', 'utf8');
const settings = fs.readFileSync('frontend/src/components/story/StorySettings.tsx', 'utf8');
const css = fs.readFileSync('frontend/src/components/story/story.css', 'utf8');

test('首屏用骨架占位，而不是先渲染「开始一个故事」再跳走', () => {
  assert.match(workbench, /import StorySkeleton from '\.\.\/components\/story\/StorySkeleton'/);
  assert.match(workbench, /const \[loading, setLoading\] = useState\(true\)/);
  assert.match(workbench, /setBusy\(''\); setLoading\(false\)/, '加载结束必须落下 loading，否则骨架一直闪');
  assert.match(workbench, /\{loading \? <StorySkeleton \/> : !project \? <StoryStart/, '顺序是先骨架、再空态：反了就会先闪一屏"你没有故事"');
  assert.match(workbench, /busy && !loading &&/, '骨架下面不该再叠一行「正在加载故事…」');
  // 骨架必须照真实版式画，否则数据到了还要重排一次，白做
  assert.match(css, /\.story-skeleton-layout/);
  assert.match(css, /prefers-reduced-motion[\s\S]{0,200}story-skeleton/, '系统要求减少动态时骨架不许闪');
  // 路由懒加载的兜底也换成骨架：它是"任何页面"都会先看到的那一屏
  const appLayout = fs.readFileSync('frontend/src/AppLayout.tsx', 'utf8');
  assert.match(appLayout, /aria-label="加载中"/, '路由兜底要有骨架，而不是一行文字');
  assert.ok(!/加载中…<\/div>/.test(appLayout), '居中的「加载中…」文字已经是过去式');
});

test('「形象」自成一组：标题、形象芯片、「新增形象」同排，和「重新生成」分开', () => {
  assert.match(settings, /story-look-row/, '形象要有自己的分组容器');
  assert.match(settings, /story-look-title/, '分组要有「形象」标题');
  assert.match(settings, /＋ 新增形象/);
  // 关键意图：新增形象属于"形象"这一组，不能继续混在「重新生成」那一行
  const actionsAt = settings.indexOf('className="story-actions"');
  assert.ok(actionsAt > 0, '操作行还在');
  const actionsBlock = settings.slice(actionsAt, settings.indexOf('</div>', actionsAt));
  assert.ok(!/新增形象/.test(actionsBlock), '「新增形象」不该再混在操作行里');
  assert.match(css, /\.story-look-row \{/);
});
