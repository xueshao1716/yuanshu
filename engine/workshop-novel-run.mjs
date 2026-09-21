import path from "node:path";
import fs from "node:fs";
import { findSkillPath } from "./workshop.mjs";
import { attachSseAbort } from "./ppt-refine.mjs";
import { findNode, FOUNDATION_NODES, isNodeReady } from "./workshop-novel-nodes.mjs";
import { bookDetail, novelsDir, readChapter, writeNotes } from "./workshop-novel.mjs";
import { pickWorkshopModel } from "./workshop-model.mjs";
import { artifactSnapshot, changedArtifact } from './novel-run-evidence.mjs';

function safeId(id) {
  const s = String(id || "");
  return /^[\w\u4e00-\u9fff-]{1,80}$/.test(s) ? s : "";
}

function persistAndReadNotes(sid, extra) {
  const live = String(extra ?? "").trim().slice(0, 8000);
  if (live) writeNotes(sid, live);
  const saved = String(bookDetail(sid)?.notes || "").trim();
  return saved || live || "（作者暂无额外意见，按技能与已有设定推进）";
}

async function runBookAgent(ctx, res, { note, prompt, timeoutMs, finishCheck, model }) {
  const { CONFIG, SESSIONS_DIR, defaultModel, createSessionAgent, SessionManager, sseWrite, req } = ctx;
  const picked = pickWorkshopModel(ctx, { model }) || defaultModel;
  res.writeHead(200, {
    "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
    Connection: "keep-alive", "X-Accel-Buffering": "no",
  });
  const write = (event, data) => { try { sseWrite(res, event, data); } catch {} };
  write("note", { text: note });
  const sm = SessionManager.create(CONFIG.cwd, SESSIONS_DIR);
  let agent = null;
  let timer = null;
  let finished = false;
  let unsub = null;
  let releaseAbort = null;
  const finish = async (okHint) => {
    if (finished) return;
    finished = true;
    try { unsub?.(); } catch {}
    try { releaseAbort?.(); } catch {}
    clearTimeout(timer);
    let result;
    try { result = okHint && finishCheck ? finishCheck() : { ok: !!okHint, note: '任务中断或超时，不视为完成' }; }
    catch { result = { ok: false, note: '产物检查失败，不视为完成' }; }
    if (result.ok) write("done", { ok: true, ...result });
    else {
      write("note", { text: result.note || "⚠️ 流程结束，但未检测到预期产物" });
      write("done", { ok: false, ...result });
    }
    try { res.end(); } catch {}
    try { agent?.abort?.(); } catch {}
    try { agent?.dispose?.(); } catch {}
  };
  try {
    agent = await createSessionAgent(sm, picked);
    releaseAbort = req ? attachSseAbort(req, () => finish(false)) : null;
    unsub = agent.subscribe((ev) => {
      try {
        if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
          write("delta", { text: ev.assistantMessageEvent.delta });
        } else if (ev.type === "tool_execution_start") {
          write("tool", { name: ev.toolName, args: ev.args, id: ev.toolCallId });
        } else if (ev.type === "tool_execution_end") {
          const text = Array.isArray(ev.result?.content) ? ev.result.content.map(c => c.text || "").join("") : "";
          write("tool_end", { name: ev.toolName, id: ev.toolCallId, isError: !!ev.isError, output: text.slice(0, 500) });
        }
      } catch {}
    });
    timer = setTimeout(() => finish(false), timeoutMs || 15 * 60 * 1000);
    await agent.prompt(prompt);
    await finish(true);
  } catch (e) {
    if (!finished) {
      finished = true;
      clearTimeout(timer);
      try { unsub?.(); } catch {}
      try { releaseAbort?.(); } catch {}
      write("error", { message: String(e?.message || e).slice(0, 300) });
      try { res.end(); } catch {}
      try { agent?.abort?.(); } catch {}
      try { agent?.dispose?.(); } catch {}
    }
  }
}

export async function handleBookWrite(ctx, res, body) {
  const { json } = ctx;
  const sid = safeId(body?.id);
  if (!sid) return json(res, 400, { error: "缺少或非法作品 id" });
  const outline = String(body?.outline || "").trim().slice(0, 800);
  const opinions = persistAndReadNotes(sid, body?.note);
  const detail = bookDetail(sid);
  if (detail.error) return json(res, 404, { error: detail.error });
  const skillPath = await findSkillPath(ctx, "novel-forge-v10");
  if (!skillPath) return json(res, 500, { error: "未找到 novel-forge-v10 技能" });
  const { meta } = detail;
  const chNo = detail.nextCh;
  const chName = `第${String(chNo).padStart(3, "0")}章.md`;
  const bd = path.join(novelsDir(), sid);
  const before = artifactSnapshot(path.join(bd, 'chapters', chName));
  const workDirUri = bd.split("\\").join("/");
  const skillUri = skillPath.split("\\").join("/");
  const prompt = `你是 novel-forge-v10 技能的执行者。为书架中的既有作品续写第 ${chNo} 章。项目已初始化，**不要重做产品化/世界观构建**，直接执行本章循环（快照→生成→免疫→审计→修改）。

## 作品档案
- 书名：《${meta.title}》（${meta.genre}题材）
- 主角：${meta.protagonist || "（见真相文件）"}
- 世界观：${meta.setting || "（见真相文件）"}
- 叙事人称铁律：${meta.narrator || "第三人称"}

## 作者意见（必须落实，高于默认套路）
${opinions}

## 本章大纲/要求
${outline || "（无指定——先读 layers/outline.md 与真相文件，按既定伏笔自然推进）"}

## 执行步骤
1. 先 read 技能文件：${skillUri}
2. read 项目内 layers/ 与 truth/ 全部文件
3. 写第 ${chNo} 章 → write 到 ${workDirUri}/chapters/${chName}
   - 开头前 20% 必须即时张力；禁天气描写、日常流程、回顾上章
   - 章末必有钩子；去 AI 味（禁「不禁/倘若/弥漫着/宛如/瞳孔骤缩」）
4. 更新 truth/：current_state.json、pending_hooks.json、chapter_summaries.json；canon.md 有新硬事实则补充
5. 回复一句话本章梗概 + 伏笔编号

所有文件操作必须在 ${workDirUri} 目录内完成。`;
  await runBookAgent(ctx, res, {
    note: `📖 开始创作《${meta.title}》第 ${chNo} 章（${meta.genre} · ${meta.narrator}）…`,
    prompt,
    model: body?.model,
    finishCheck: () => {
      const chPath = path.join(bd, "chapters", chName);
      return { ...changedArtifact(chPath, before), chapter: chName, no: chNo };
    },
  });
}

export async function handleBookAdvance(ctx, res, body) {
  const { json } = ctx;
  const sid = safeId(body?.id);
  const node = findNode(body?.node);
  if (!sid) return json(res, 400, { error: "缺少或非法作品 id" });
  if (!node?.generate || !node.file) return json(res, 400, { error: "该节点不能生成" });
  const detail = bookDetail(sid);
  if (detail.error) return json(res, 404, { error: detail.error });
  const skillPath = await findSkillPath(ctx, "novel-forge-v10");
  if (!skillPath) return json(res, 500, { error: "未找到 novel-forge-v10 技能" });
  const opinions = persistAndReadNotes(sid, body?.note);
  const bd = path.join(novelsDir(), sid);
  const workDirUri = bd.split("\\").join("/");
  const skillUri = skillPath.split("\\").join("/");
  const { meta } = detail;
  const prompt = `你是 novel-forge-v10 技能的执行者。只推进管道节点「${node.label}」，写入 ${workDirUri}/${node.file}。

## 作品档案
- 书名：《${meta.title}》（${meta.genre}）
- 主角：${meta.protagonist || "待定"}
- 世界观：${meta.setting || "待定"}
- 人称：${meta.narrator || "第三人称"}

## 作者意见（必须落实）
${opinions}

## 步骤
1. read 技能：${skillUri}
2. read 已有 layers/ 与 truth/、product.md（若存在）
3. 按 v10 该节点规范，用 write 覆盖 ${workDirUri}/${node.file}
4. 不要写章节正文，不要改其他节点文件
5. 回复三句：写了什么、还缺什么、建议下一节点

所有文件操作必须在 ${workDirUri} 内。`;
  const before = artifactSnapshot(path.join(bd, node.file));
  await runBookAgent(ctx, res, {
    note: `推进节点：${node.label}`,
    prompt,
    model: body?.model,
    timeoutMs: 8 * 60 * 1000,
    finishCheck: () => {
      const f = path.join(bd, node.file);
      const evidence = changedArtifact(f, before);
      return evidence.ok && isNodeReady(node, artifactSnapshot(f)?.text || '') ? { ...evidence, node: node.id } : { ok: false, note: evidence.note || '节点仍未通过产物检查' };
    },
  });
}

export async function handleBookRevise(ctx, res, body) {
  const { json } = ctx;
  const sid = safeId(body?.id);
  if (!sid) return json(res, 400, { error: "缺少或非法作品 id" });
  const detail = bookDetail(sid);
  if (detail.error) return json(res, 404, { error: detail.error });
  if (!detail.chapters.length) return json(res, 400, { error: "还没有章节可修订" });
  const last = detail.chapters[detail.chapters.length - 1];
  const skillPath = await findSkillPath(ctx, "novel-forge-v10");
  if (!skillPath) return json(res, 500, { error: "未找到 novel-forge-v10 技能" });
  const opinions = persistAndReadNotes(sid, body?.note);
  const bd = path.join(novelsDir(), sid);
  const src = path.join(bd, "chapters", last.file);
  const before = artifactSnapshot(src);
  const snap = path.join(bd, "snapshots", last.file.replace(".md", ".prev.md"));
  try {
    fs.mkdirSync(path.dirname(snap), { recursive: true });
    fs.copyFileSync(src, snap);
  } catch { return json(res, 500, { error: '原章备份失败，未开始修订' }); }
  const workDirUri = bd.split("\\").join("/");
  const skillUri = skillPath.split("\\").join("/");
  const current = readChapter(sid, last.file).content || "";
  const prompt = `你是 novel-forge-v10 的修订编辑。修订《${detail.meta.title}》${last.file}：对抗编辑 + 去 AI 味 + 只改问题维。

## 作者意见（必须落实，高于默认修订清单）
${opinions}

## 当前正文
${current.slice(0, 12000)}

## 步骤
1. read ${skillUri}
2. 把修订后的完整章节 write 到 ${workDirUri}/chapters/${last.file}（覆盖）
3. 需要时更新 truth/chapter_summaries.json
4. 回复：改了哪几处、还剩什么风险

文件操作必须在 ${workDirUri} 内。原章备份已在 snapshots/。`;
  await runBookAgent(ctx, res, {
    note: `修订 ${last.file}`,
    prompt,
    model: body?.model,
    finishCheck: () => ({ ...changedArtifact(src, before), chapter: last.file, no: last.no }),
  });
}

export async function handleBookStudio(ctx, res, body) {
  const { json } = ctx;
  const sid = safeId(body?.id);
  if (!sid) return json(res, 400, { error: "缺少或非法作品 id" });
  const detail = bookDetail(sid);
  if (detail.error) return json(res, 404, { error: detail.error });
  const skillPath = await findSkillPath(ctx, "novel-forge-v10");
  if (!skillPath) return json(res, 500, { error: "未找到 novel-forge-v10 技能" });
  const opinions = persistAndReadNotes(sid, body?.note);
  const bd = path.join(novelsDir(), sid);
  const workDirUri = bd.split("\\").join("/");
  const skillUri = skillPath.split("\\").join("/");
  const { meta } = detail;
  const files = FOUNDATION_NODES.map(id => findNode(id)).filter(Boolean)
    .map(n => `- ${n.label} → ${workDirUri}/${n.file}`).join("\n");
  const prompt = `你是 novel-forge-v10 的 studio 执行者。一次完成强制工作流的基础构建（不要写章节）：产品化 → 5层共进化 → 真相文件初始化。

## 作品档案
- 书名：《${meta.title}》（${meta.genre}）
- 主角：${meta.protagonist || "待定"}
- 世界观：${meta.setting || "待定"}
- 人称：${meta.narrator || "第三人称"}

## 作者意见（必须落实，高于默认套路）
${opinions}

## 必须用 write 覆盖这些文件（不要留「待构建」占位）
${files}
另外初始化（有内容就写，空数组也要合理结构）：
- ${workDirUri}/truth/current_state.json
- ${workDirUri}/truth/pending_hooks.json
- ${workDirUri}/truth/particle_ledger.json
- ${workDirUri}/truth/subplot_board.json
- ${workDirUri}/truth/emotional_arcs.json
- ${workDirUri}/truth/character_matrix.json
- ${workDirUri}/truth/chapter_summaries.json

## 步骤
1. read 技能：${skillUri}
2. 按 v10 Phase 0（市场/读者/卖点/差异化）写 product.md
3. 按 5 层共进化写 voice/world/characters/outline/canon，上下游一致
4. 用刚写的层去填真相 JSON
5. 不要写 chapters/ 下任何章节
6. 回复：各文件各写了什么、作者意见落实在哪

全部文件操作必须在 ${workDirUri} 内。`;
  await runBookAgent(ctx, res, {
    note: `自动生成设定：《${meta.title}》产品化 + 五层 + 真相`,
    prompt,
    model: body?.model,
    timeoutMs: 15 * 60 * 1000,
    finishCheck: () => {
      try {
        const ok = FOUNDATION_NODES.every(id => {
          const node = findNode(id);
          return node?.file && isNodeReady(node, fs.readFileSync(path.join(bd, node.file), 'utf8'));
        });
        return ok ? { ok: true } : { ok: false, note: "设定文件仍像占位，请看过程日志后重试" };
      } catch {
        return { ok: false };
      }
    },
  });
}
