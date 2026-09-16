// 台前入口的契约（分集 / 原著改编 / 批量生成 / 风格预设）。
//
// 这一层测试只锁一件事：**功能在界面上真的存在，并且接到了真正的通路上**。
// 后端算得再对，界面上没有入口 = 这个功能不存在（这套项目里已经发生过三次）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = p => fs.readFileSync(p, 'utf8');
const workbench = read('frontend/src/pages/StoryWorkbench.tsx');
const adapt = read('frontend/src/components/story/StoryAdapt.tsx');
const batch = read('frontend/src/components/story/StoryBatch.tsx');
const episodes = read('frontend/src/components/story/StoryEpisodes.tsx');
const api = read('frontend/src/api.ts');
const types = read('frontend/src/types.ts');
const styles = read('frontend/src/lib/story-styles.ts');
const settings = read('frontend/src/components/story/StorySettings.tsx');
const css = read('frontend/src/components/story/story.css');
const server = read('server.mjs');
const orchestrator = read('engine/story-orchestrator.mjs');
const store = read('engine/story-store.mjs');
const craft = read('engine/story-craft.mjs');

test('分集：面板挂在制作台，点某一场要真的跳到那一场', () => {
  assert.match(workbench, /StoryEpisodes/, '分集面板要挂在制作台里');
  assert.match(episodes, /StoryApi\.addEpisode/);
  assert.match(episodes, /StoryApi\.updateEpisode/);
  assert.match(episodes, /StoryApi\.removeEpisode/);
  assert.match(episodes, /StoryApi\.assignScene/);
  assert.match(episodes, /未分集/, '要允许"未分集"，不能强迫每场都归集');
  assert.match(episodes, /里\S{0,4}的场回到「未分集」，一个都没丢/, '删集只解绑不删场，界面上要说清');
  assert.match(api, /\/episodes\/remove/);
  assert.match(api, /scene-assign/);
  assert.match(types, /StoryEpisodeGroup/);
  // selected 可能是场 id（分集面板点进来）也可能是段 id，两种都要能定位到那一场，
  // 否则从分集面板点「第 3 场」会被静默落到第 1 场，看起来像跳转失灵
  assert.match(workbench, /s\.id === selected \|\| s\.beats\.some\(b => b\.id === selected\)/);
  assert.match(css, /\.story-episode-group/);
});

test('原著改编：入口、预览不花钱、字数上限说清、改编记录看得见', () => {
  assert.match(workbench, /StoryAdapt/, '改编面板要挂在制作台里');
  assert.match(adapt, /StoryApi\.adapt/);
  assert.match(adapt, /NovelApi\.detail/, '要能从小说工坊按书导入');
  assert.match(adapt, /NovelApi\.books/);
  assert.match(adapt, /preview: true|preview,/, '「预览」走的必须是 preview 通路');
  assert.match(adapt, /预览（不调模型）/, '预览要写明它不调模型（不然用户不敢点）');
  assert.match(adapt, /SOURCE_CAP = 60000/);
  assert.match(adapt, /只取前 \$\{SOURCE_CAP\} 字/, '原文被截断必须说清，不能让人以为整本都改编了');
  assert.match(adapt, /不选 = 改编整本/);
  assert.match(adapt, /改编记录/, '改编史要在界面上看得见（刷新后仍能回答"从哪本书改的"）');
  assert.match(adapt, /未解析出来/, '哪几集没解析出来要如实显示');
  assert.match(adapt, /模型第一次给的集数不够/, '自动重试要告诉用户，不能默默替他做决定');
  assert.match(adapt, /aria-label="小说原文"/);
  assert.match(adapt, /aria-label="集数"/);
  assert.match(adapt, /aria-label="单集秒数"/);
  assert.match(adapt, /aria-label="改编要求"/);
  // 通路的每一段都要在
  assert.match(api, /\/adapt`/);
  assert.match(api, /StoryAdaptResult/);
  assert.match(server, /\/adapt\$/);
  assert.match(server, /readStoryNovelBook/);
  assert.match(server, /readNovelBook: readStoryNovelBook/);
  assert.match(orchestrator, /adapt: async \(id, input = \{\}\)/);
  assert.match(types, /adaptations\?: StoryAdaptation\[\]/);
  assert.match(css, /\.story-adapt/);
});

test('改编：段落类型不能被项目默认配方抹平（这是改编结果本身，不是工艺）', () => {
  // 一键分镜会盖默认配方的 kind；改编**不能**——novel/image/video 的分工是改编结果
  const inAdapt = orchestrator.slice(orchestrator.indexOf('adapt: async (id, input = {})'), orchestrator.indexOf('assembleFilm: async'));
  assert.match(inAdapt, /kind: \['novel', 'image', 'video'\]\.includes\(beat\.kind\) \? beat\.kind : \(stampRecipe\?\.kind \|\| 'image'\)/);
  assert.match(inAdapt, /stampRecipe\?\.negative/, '负向是工艺，照旧套用');
  assert.match(inAdapt, /collectAdaptSource\(input, readNovelBook\)/);
  assert.match(orchestrator, /preview: true, source: sourceBrief, episodeWish, secondsPerEpisode/);
});

test('批量生成：逐段串行提交 + 统一等上游；超窗不算失败；每段成败都列出来', () => {
  assert.match(workbench, /StoryBatch/, '批量面板要挂在制作台里');
  assert.match(workbench, /selectedSceneId=\{scene\?\.id\}/, '批量要拿到真正的场 id');
  assert.match(batch, /for \(const \[i, t\] of list\.entries\(\)\)/, '必须逐段串行提交');
  assert.ok(!/Promise\.all/.test(batch), '不能并发轰炸上游：视频任务本来就要排队，并发只会一起超窗');
  assert.match(batch, /StoryApi\.checkRuns/, '收尾查询要合并成一次请求（照 Lovart 的读写分档）');
  assert.ok(!/StoryApi\.checkRun\(/.test(batch), '不能再逐个 run 去问：N 个任务号就是 N 个请求 + N 轮上游问答');
  assert.match(batch, /POLL_MAX_MS/, '轮询间隔要退避，不能一直按最短间隔问');
  assert.match(batch, /逐段串行提交/, '界面上要说清它是串行的');
  assert.match(batch, /这不是失败/, '超窗必须说清不是失败（任务号还在）');
  assert.match(batch, /只算「排上队」/, '创建成功只是排队，不能报成"出片了"');
  assert.match(batch, /停止/);
  assert.match(batch, /失败/);
  assert.match(batch, /aria-label|当前场|当前集/, '范围要能选：这一场 / 这一集 / 全项目');
  assert.match(batch, /scope === 'episode'/, '要能"这一集全部生成"');
  assert.match(css, /\.story-batch/);
});

test('高消耗操作先确认（照 Lovart 的 confirm）：跑之前摊开"这次要真实调用什么"', () => {
  // 有视频段（上游要排队出片）或一次 4 段以上，才拦一道——每次都弹确认，确认就会被闭眼点掉
  assert.match(batch, /const needConfirm = stage === 'idle' && targets\.length > 0 && \(plan\.video > 0 \|\| targets\.length >= 4\)/);
  assert.match(batch, /'idle' \| 'confirm' \| 'running'/);
  assert.match(batch, /这次会<strong>真实调用<\/strong>/);
  assert.match(batch, /合计约 \$\{plan\.videoSeconds\} 秒/);
  assert.match(batch, /确认，跑这 \{targets\.length\} 段/);
  assert.match(batch, /已取消，什么都没提交/, '取消要说清"什么都没提交"，不能让人以为已经跑了');
  // 不编造单价：只报"会真实调用多少次、要等多久"，额度归各平台各自计费
  assert.match(batch, /额度由各平台各自计费，元枢不代扣也不退/);
  assert.ok(!/[¥$€]\s?\d|credits|积分/.test(batch), '不许自己编价格或积分（我们没有单价数据，编一个数就是骗人）');
  assert.match(css, /\.story-batch-confirm/);
  const api = read('frontend/src/api.ts');
  assert.match(api, /run-check-many/);
  assert.match(server, /run-check-many/);
  assert.match(orchestrator, /checkRuns: async \(id, input = \{\}\)/);
});

test('创作方法包：界面要能选、能套用、能把项目跑通的打法存下来（照 Lovart 的 Skill）', () => {
  const method = read('frontend/src/components/story/StoryMethod.tsx')
  assert.match(workbench, /StoryMethod/, '方法包面板要挂在制作台里');
  assert.match(method, /StoryApi\.methods/);
  assert.match(method, /StoryApi\.applyMethod/);
  assert.match(method, /StoryApi\.captureMethod/, '要能把当前项目跑通的打法存成方法包');
  assert.match(method, /StoryApi\.deleteMethod/);
  assert.match(method, /复制成我的（内置不可改）/, '内置方法包要能复制成自己的再改');
  assert.match(method, /aria-label="选择方法包"/);
  assert.match(method, /aria-label="方法包名字"/);
  assert.match(method, /不会把你这个项目的提示词和台词抄进去/, '要说清存的是结构不是内容');
  assert.match(method, /方法包管<strong>怎么拍<\/strong>/, '要说清方法与配方的分工');
  assert.match(method, /深思档|快档/, '推理档位要看得见');
  assert.match(api, /\/api\/story\/methods/);
  assert.match(api, /method-capture/);
  assert.match(api, /captureMethod/);
  assert.match(server, /\/api\/story\/methods/);
  assert.match(server, /method-capture/);
  assert.match(orchestrator, /captureMethod: async/);
  assert.match(orchestrator, /applyMethod: async/);
  // 方法必须真的进提示词与预算，否则它只是一段没人读的说明
  assert.match(orchestrator, /methodBrief\(method\)/);
  assert.match(orchestrator, /reasoningBudget\(method\?\.reasoning/);
  assert.match(types, /methodId\?: string/);
  assert.match(types, /export interface StoryMethod/);
  assert.match(css, /\.story-method/);
});

test('删掉不要的那几版：确认块 + 「文件留不留」必须给用户选', () => {
  const results = read('frontend/src/components/story/StoryResults.tsx')
  assert.match(workbench, /onDelete=\{deleteRun\}/, '删除要接回编排层');
  assert.match(workbench, /StoryApi\.deleteRun/, '要真的调用删除通路');
  assert.match(results, /删除这一版/);
  assert.match(results, /role="alertdialog"/, '不可逆操作要有明确的确认块，不能点一下就没了');
  assert.match(results, /只从列表里移除，文件留着/, '文件留不留要让用户选');
  assert.match(results, /只要还有别的地方（别的段、别的项目）在用它，就会自动保留/, '要说清文件什么时候会被保留');
  assert.match(results, /上游出的片子删掉后就收不回来了/, '排队中的版本要提示后果');
  assert.match(css, /\.story-confirm/);
  assert.match(api, /run-delete/);
  assert.match(server, /run-delete\$/);
  assert.match(orchestrator, /deleteRun: async/);
});

test('挑片段合成：默认还是原来那套，改了才按你的；挑不出来要逐条说明', () => {
  // 成片面板拆成两半：StoryFilm 管状态与合成动作，StoryTimeline 管"由哪几段、多长、用第几版"的画法。
  // 这里的规矩两条文件一起看——规矩本身没变，只是换了个文件承载。
  const film = read('frontend/src/components/story/StoryFilm.tsx') + read('frontend/src/components/story/StoryTimeline.tsx')
  assert.match(workbench, /StoryFilm/, '挑片段面板要挂在制作台里');
  assert.match(film, /StoryApi\.filmPlan/, '要先拿到候选清单');
  assert.match(film, /StoryApi\.film\(project\.id, \{ clips: picks \}\)/, '合成时把挑好的版本与顺序送上去');
  assert.match(film, /默认就是原来那套/, '不改也能一键合成——不能为了新功能把老路堵掉');
  assert.match(film, /先下载到本地再拼/, '外链片段要先下载到本地，这是本地化契约');
  assert.match(film, /c\.localable/, '可选的版本按"本地已有或能下载"来判，不能只认本地文件');
  assert.match(film, /外链（合成时先下载到本地）/, '界面要标出哪一版是外链');
  assert.match(film, /aria-label=\{`第 \$\{beat\.beatNo\} 段用哪一版`\}/, '每一段要能换版本');
  assert.match(film, /上移|下移/, '顺序就是成片里的先后，要能调');
  assert.match(film, /整段不要/, '要能整段排除');
  assert.match(film, /按这个顺序合成/, '按钮要说清"按这个顺序"');
  assert.match(film, /没拼进去/, '拼不进去的段要如实回报，不能静默少一段');
  assert.match(film, /本地都找不到片子了|先给它生成一段视频/, '文件不在/没生成要给不同的说法');
  assert.match(film, /记下用了哪几段的哪一版/, '成片要能追溯用了哪一版镜头');
  // 类名不能叫 story-timeline：那个名字已经被左侧「分镜时间线」占着，会互相污染样式
  assert.match(css, /\.story-film-timeline/);
  assert.match(api, /film-plan/);
  assert.match(server, /film-plan\$/);
  assert.match(orchestrator, /filmPlan: async/);
  assert.match(types, /StoryFilmPlan/);
  assert.match(types, /picks\?: \{ beatId: string; runId: string \}\[\]/);
});

test('外链产物要有补下载入口（本地化契约：外站链接会自己过期）', () => {
  const results = read('frontend/src/components/story/StoryResults.tsx')
  assert.match(workbench, /onLocalize=\{localizeRun\}/, '补下载要接回编排层');
  assert.match(workbench, /StoryApi\.localizeRun/);
  assert.match(results, /外链产物 · 下载到本地/);
  assert.match(results, /\^https\?:/i, '只对真的还是外链的版本显示这个入口');
  assert.match(workbench, /只补下载、不重新生成|只补下载/, '要说清它不重新生成（不额外花钱）');
  assert.match(api, /run-localize/);
  assert.match(server, /run-localize\$/);
  assert.match(orchestrator, /localizeRun: async/);
});

test('参考图也受本地化契约：标出外链，并能一次把全项目的产物拉到本地', () => {
  const settings = read('frontend/src/components/story/StorySettings.tsx')
  assert.match(settings, /外链 · 会过期/, '参考图是外链时要标出来（它是长期复用的锚点，过期就悄悄失效）');
  assert.match(settings, /把外站的产物拉到本地/, '要有全项目补下载入口');
  assert.match(settings, /参考图与产出都算在内/, '要说清这个入口覆盖什么');
  assert.match(workbench, /externalAssets/, '要算出还有多少外链产物');
  assert.match(workbench, /StoryApi\.localize\(project\.id, \{ scope: 'all' \}\)/, '补下载走 /localize');
  assert.match(workbench, /挂载素材不重复落盘/, '挂载素材为什么不落盘要说出来');
  assert.match(workbench, /onLocalizeAll=\{localizeAll\}/);
  assert.match(api, /localize: \(id: string/, '前端要接上全项目补下载');
  assert.match(server, /\/localize\$/);
  assert.match(orchestrator, /localizeProject: async/);
  // 窗口放大到 4000：这段里后来又加了"形象变体"的解析逻辑，2000 字已经不够；
  // 这条断言的本意是"localizeError 必须出现在 generateAssetRef 里"，窗口太紧只会误报。
  assert.match(orchestrator, /generateAssetRef[\s\S]{0,4000}localizeError/, '参考图没落盘时要如实带出来');
  assert.match(css, /\.story-external/);
});

test('项目：不用下拉框了，改成能看能删的项目架', () => {
  const shelf = read('frontend/src/components/story/StoryProjects.tsx')
  assert.match(workbench, /StoryProjects/, '项目架要挂在制作台里');
  assert.match(shelf, /StoryApi\.deleteProject/);
  assert.match(shelf, /role="alertdialog"/, '删项目不可逆，要有确认块');
  assert.match(shelf, /连产物文件一起删（只删没有被别的项目引用的）/, '要不要删文件必须让用户选，并说清边界');
  assert.match(shelf, /产物文件会留着——工作区里还能从「资产」找到它们/, '默认保文件要说清');
  assert.match(shelf, /story-projects\/\.trash\//, '要说清副本留在哪、能恢复');
  assert.match(shelf, /点「打开」才切换当前项目/, '翻列表不该顺手换掉正在写的项目');
  assert.match(shelf, /改动于 .*toLocaleString/, '列表里要看得见时间，别只有标题');
  assert.match(shelf, /集|成片/, '列表里要看得见规模（场/段/集/成片）');
  // 下拉框必须真的撤掉，而不是两套并存
  assert.ok(!/aria-label="选择故事项目"/.test(workbench), '旧的 <select> 下拉框应当已经被项目架取代');
  assert.match(api, /deleteProject/);
  assert.match(server, /\["DELETE", \/\^\\\/api\\\/story\\\/projects/);
  assert.match(orchestrator, /deleteProject: async/);
  assert.match(store, /export async function trashProject/, '先留副本再删');
  assert.match(css, /\.story-project-item/);
});

test('台词专科：先机检（不花钱）再诊断（花一次）；改写必须给依据，采纳只写回那一句', () => {
  const panel = read('frontend/src/components/story/StoryDialogue.tsx')
  assert.match(workbench, /StoryDialogue/, '台词面板要挂在制作台里');
  assert.match(panel, /StoryApi\.dialogueAudit/, '机检要能单独跑（不花钱）');
  assert.match(panel, /StoryApi\.dialogueDoctor/, '诊断才调模型');
  assert.match(panel, /台词体检（不花钱）/, '界面上要说清哪一步不花钱');
  assert.match(panel, /3\.5~5 字\/秒/, '语速基准要写在界面上');
  assert.match(panel, /单句超过 24 字就得拆镜/, '拆镜阈值要说出来');
  assert.match(panel, /依据不足/, '依据不足 3 条的改写要标出来');
  assert.match(panel, /机检查不了/, '哪几维机检查不了要老实说');
  assert.match(panel, /同段其它台词一个字不动/, '采纳必须只写回那一句');
  assert.match(panel, /只替换这一句/, '代码注释也要说明这条边界');
  assert.match(api, /dialogue-audit/);
  assert.match(api, /dialogue-doctor/);
  assert.match(server, /dialogue-audit\$/);
  assert.match(server, /dialogue-doctor\$/);
  assert.match(orchestrator, /dialogueAudit: async/);
  assert.match(orchestrator, /dialogueDoctor: async/);
  assert.match(craft, /speechCheck|dialogueAudit/);
  assert.match(css, /\.story-dialogue/);
});

test('深度构思：情绪契约 / 人物四件套 / 矛盾单元 / 分集地图 / 伏笔账都要看得见', () => {
  const panel = read('frontend/src/components/story/StoryCraft.tsx')
  assert.match(workbench, /StoryCraft/, '构思面板要挂在制作台里');
  assert.match(panel, /StoryApi\.storyEngine/, '构思走模型');
  assert.match(panel, /StoryApi\.saveCraft/, '草稿要人确认后才保存');
  assert.match(panel, /StoryApi\.applyEpisodeMap/, '分集地图要能一键建成集');
  assert.match(panel, /还没写进项目/, '草稿状态要说清');
  assert.match(panel, /情绪契约/);
  assert.match(panel, /语言指纹|欲望|秘密|弧光/, '人物四件套要摊开');
  assert.match(panel, /矛盾单元|硬帽/, '单元与硬帽要看得见');
  assert.match(panel, /断章钩子|前 3 秒/, '每集的目标/开场/钩子要看得见');
  assert.match(panel, /伏笔账|没写回收集/, '伏笔回收要说清');
  assert.match(panel, /机检只查结构/, '机检边界要老实说');
  assert.match(api, /story-engine/);
  assert.match(api, /episode-map/);
  assert.match(server, /story-engine\$/);
  assert.match(server, /episode-map\$/);
  assert.match(orchestrator, /storyEngine: async/);
  assert.match(orchestrator, /applyEpisodeMap: async/);
  // craft 是项目字段：白名单不登记就写不回来（这个坑踩过四次）
  assert.match(store, /\.\.\.\(input\.craft \? \{ craft: input\.craft \}/);
  assert.match(types, /craft\?: StoryCraftEngine/);
  assert.match(css, /\.story-craft/);
});

test('风格预设：是可选的统一画风，不是又一句自由发挥', () => {
  const ids = [...styles.matchAll(/^    id: '([a-z0-9-]+)'/gm)].map(m => m[1]);
  assert.equal(ids.length, 10, '预置 10 种画风');
  assert.equal(new Set(ids).size, ids.length, 'id 不能重复');
  assert.match(styles, /export function stylePresetById/);
  assert.match(styles, /fill.*bible\.style|bible\.style/);
  assert.match(settings, /STYLE_PRESETS/);
  assert.match(settings, /aria-label="风格预设"/);
  assert.match(settings, /style: `\$\{p\.visual\}；\$\{p\.tone\}（\$\{p\.name\}）`/, '选完要写进 bible.style，而且仍可手改');
  assert.match(css, /\.story-style-presets/);
});
