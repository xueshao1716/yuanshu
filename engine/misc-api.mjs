// engine/misc-api.mjs —— 杂项 API 组（2026-08-29 #7 红线治理从 server.mjs 拆出）
// 包含：scanRecentArtifacts（产物扫描）/ prompts / sessions tree+branch / models remove /
//       search / git status+diff。工厂模式显式注入。

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createReviewVerification } from './review-verification.mjs';

export function createMiscApi(deps) {
  const {
    json, readJsonFile, writeJsonFile,
    getAgentDir, authPath, modelsPath,
    openSession, ensureAgent, getDefaultModel,
    refreshModelList, scanSessionFiles, extractText, parseSessionFile,
    cwd, scanExclude, gitCwd = null, projectRoot = null, gitRunner: injectedGitRunner = null,
  } = deps;
  // Git 验收默认针对元枢源码仓库；工作空间仍由 cwd 提供给产物、会话等 API。
  const reviewRoot = path.resolve(gitCwd || cwd);
  const appRoot = path.resolve(projectRoot || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));

  // 产物扫描：只扫关键目录（根目录 + 生成物/ + 收发文件/今天 + 工程/），时间窗内 + 成品类型
  function scanRecentArtifacts(withinMs = 2 * 60 * 1000, max = 10) {
    try {
      const root = path.resolve(cwd);
      if (!fs.existsSync(root)) return [];
      const now = Date.now();
      const out = [];
      const today = new Date().toISOString().slice(0, 10);
      const scanDirs = [root, path.join(root, "生成物"), path.join(root, "收发文件", today), path.join(root, "工程")];
      const seenNames = new Set();
      const collect = (dir, recursive) => {
        let items;
        try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const it of items) {
          if (it.name.startsWith(".") || it.name.startsWith("_")) continue;
          if (scanExclude.test(dir + path.sep + it.name)) continue;
          if (it.isDirectory()) {
            if (recursive && it.name !== "node_modules") collect(path.join(dir, it.name), true);
            continue;
          }
          const full = path.join(dir, it.name);
          let st;
          try { st = fs.statSync(full); } catch { continue; }
          if (st.size <= 0 || now - st.mtimeMs >= withinMs) continue;
          const ext = path.extname(it.name).toLowerCase();
          if (!/^\.(html|htm|md|txt|js|css|json|py|png|jpg|jpeg|gif|webp|pdf|docx?|xlsx?|pptx?|mp3|wav|mp4|webm|svg|zip)$/.test(ext)) continue;
          if (seenNames.has(it.name)) continue;
          seenNames.add(it.name);
          out.push({ name: it.name, path: path.relative(root, full).replace(/\\/g, "/"), size: st.size, mime: "", mtimeMs: st.mtimeMs });
        }
      };
      for (const dir of scanDirs) collect(dir, dir === path.join(root, "工程"));
      const priority = (name) => {
        const ext = path.extname(name).toLowerCase();
        if (/^\.(html?|md|pdf|docx?|pptx?|png|jpe?g|gif|webp)$/.test(ext)) return 0;
        if (/^\.(zip|mp4|mp3|wav|svg|json)$/.test(ext)) return 1;
        if (/^\.(js|css|py|txt|ts)$/.test(ext)) return 2;
        return 3;
      };
      return out.sort((a, b) => priority(a.name) - priority(b.name) || (b.mtimeMs || 0) - (a.mtimeMs || 0)).slice(0, max);
    } catch { return []; }
  }

  // GET /api/prompts —— 提示词模板目录
  async function handlePrompts(res) {
    const dir = path.join(getAgentDir(), "prompts");
    const list = [];
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".md")) continue;
        const content = fs.readFileSync(path.join(dir, f), "utf8");
        const name = f.replace(/\.md$/, "");
        let desc = "";
        let body = content;
        const fm = content.match(/^---\n([\s\S]*?)\n---\n?/);
        if (fm) {
          const dm = fm[1].match(/description:\s*(.+)/);
          if (dm) desc = dm[1].trim();
          body = content.slice(fm[0].length);
        }
        list.push({ name, description: desc || (body.split("\n")[0] || "").slice(0, 60), content: body.trim() });
      }
    } catch {}
    json(res, 200, { prompts: list });
  }

  // GET /api/sessions/:id/tree —— 会话分支树
  async function handleSessionTree(res, id) {
    const entry = await openSession(id);
    if (!entry) return json(res, 404, { error: "会话不存在" });
    const sm = entry.sm;
    const roots = sm.getTree();
    const leafId = sm.getLeafId();
    const isMsg = (n) => n.entry?.type === "message" && ["user", "assistant"].includes(n.entry?.message?.role);
    const simplify = (node, depth = 0, budget = { n: 0 }) => {
      budget.n++;
      if (depth > 8 || budget.n > 400) return null;
      const children = (node.children || [])
        .map((c) => simplify(c, depth + 1, budget))
        .filter(Boolean)
        .slice(0, 30);
      if (!isMsg(node)) {
        if (!children.length) return null;
        return { id: node.entry.id, type: node.entry.type, children };
      }
      const content = node.entry.message?.content || [];
      const text = (content.filter((b) => b.type === "text").map((b) => b.text || "").join("") || node.entry.message?.text || "").slice(0, 50);
      return { id: node.entry.id, role: node.entry.message.role, text, ts: node.entry.timestamp, children };
    };
    json(res, 200, { tree: roots.map((s) => simplify(s)).filter(Boolean), leafId });
  }

  // POST /api/sessions/:id/branch {entryId} —— 从某条消息分叉
  async function handleSessionBranch(res, id, body) {
    const entry = await openSession(id);
    if (!entry) return json(res, 404, { error: "会话不存在" });
    const entryId = body?.entryId;
    if (!entryId) return json(res, 400, { error: "缺少 entryId" });
    try {
      entry.sm.branch(entryId);
      if (entry.agent) { try { entry.agent.dispose(); } catch {} entry.agent = null; }
      await ensureAgent(entry, getDefaultModel());
      json(res, 200, { ok: true, leafId: entry.sm.getLeafId() });
    } catch (e) {
      json(res, 500, { error: String(e?.message || e).slice(0, 150) });
    }
  }

  // POST /api/models/remove —— 删除自定义 provider
  async function handleModelsRemove(res, body) {
    const { provider } = body || {};
    if (!provider) return json(res, 400, { error: "缺少 provider" });
    const auth = readJsonFile(authPath); delete auth[provider]; writeJsonFile(authPath, auth);
    const store = readJsonFile(modelsPath); delete store[provider]; writeJsonFile(modelsPath, store);
    await refreshModelList();
    json(res, 200, { ok: true });
  }

  // GET /api/search?q= —— 搜索所有会话历史
  async function handleSearch(res, q) {
    q = (q || "").trim();
    if (q.length < 2) return json(res, 200, { results: [] });
    const ql = q.toLowerCase();
    const results = [];
    for (const file of scanSessionFiles()) {
      try {
        const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
        const hits = [];
        for (const line of lines) {
          let e; try { e = JSON.parse(line); } catch { continue; }
          if (e.type !== "message" || !e.message) continue;
          const text = extractText(e.message.content);
          if (!text || !text.toLowerCase().includes(ql)) continue;
          hits.push({ role: e.message.role, snippet: text.replace(/\s+/g, " ").slice(0, 160) });
          if (hits.length >= 3) break;
        }
        if (hits.length) {
          const info = parseSessionFile(file);
          results.push({ sessionId: info.id, name: info.name || "会话", preview: info.preview, hits });
        }
      } catch {}
    }
    json(res, 200, { results: results.slice(0, 20) });
  }

  // GET /api/aibody —— 将 AIBody 理论映射到当前代码中可验证的模块。
  // 这是一个只读的“系统脉络”快照，不把理论写进人格提示词，也不暴露文件内容。
  async function handleAIBody(res) {
    const moduleMap = {
      host: [
        ['运行时与模型', 'server.mjs'],
        ['工具执行与安全', 'engine/tools/unified-tools.mjs'],
        ['会话编排', 'engine/agent-loop.mjs'],
      ],
      organism: [
        ['基因与继承', 'engine/gene.mjs'],
        ['技能路由', 'engine/skill-gene.mjs'],
        ['记忆治理', 'engine/memory-gardener.mjs'],
        ['工作记忆', 'engine/yuanshu-workmem.mjs'],
        ['关系与情绪', 'engine/emotion.mjs'],
        ['判断与改进', 'engine/improve-api.mjs'],
      ],
      expression: [
        ['对话与交付', 'frontend/src/components/ChatArea.tsx'],
        ['工作台与状态', 'frontend/src/pages/Board.tsx'],
        ['主题与壁纸', 'frontend/src/theme/apply.ts'],
      ],
    };
    const layerMeta = {
      host: { label: '宿主层', summary: '模型、工具和运行时，提供行动边界。' },
      organism: { label: '母体层', summary: '基因、记忆、技能、关系与治理，形成持续性。' },
      expression: { label: '表现层', summary: '对话、工作台与交付，把系统状态呈现给你。' },
    };
    const layers = Object.entries(moduleMap).map(([id, entries]) => ({
      id, label: layerMeta[id].label, summary: layerMeta[id].summary,
      modules: entries.map(([label, relativePath]) => ({ label, path: relativePath, available: fs.existsSync(path.join(appRoot, relativePath)) })),
    }));
    json(res, 200, {
      updatedAt: new Date().toISOString(),
      principle: '自信底色，越自信越谨慎；能力可以成长，主权与边界不能被绕过。',
      theory: [
        { id: 'continuity', label: '连续性', detail: '记忆、关系和技能共同维护跨任务的身份连续。', evidence: ['engine/memory-gardener.mjs', 'engine/emotion.mjs', 'engine/skill-gene.mjs'] },
        { id: 'judgment', label: '判断', detail: '先解释为什么这样做，再交付结果，并把风险留在台面上。', evidence: ['engine/improve-api.mjs', 'engine/yuanshu-delegate.mjs'] },
        { id: 'sovereignty', label: '主权边界', detail: '删除、密钥、支付、人格与隧道等高风险能力保持物理隔离。', evidence: ['engine/tools/security.mjs', 'engine/tools/approval.mjs'] },
      ],
      layers,
    });
  }

  // Git 集成
  function runGit(args) {
    if (typeof injectedGitRunner === "function") return injectedGitRunner(args);
    return new Promise((resolve) => {
      execFile("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 8000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
        if (err) {
          const msg = String(err.message || "");
          if (msg.includes("not a git repository") || msg.includes("Not a git repository")) {
            return resolve({ ok: false, isRepo: false, output: "" });
          }
          if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer length exceeded/i.test(msg)) {
            return resolve({ ok: false, isRepo: true, output: "", error: "output_too_large" });
          }
          return resolve({ ok: false, isRepo: true, output: msg.split("\n").slice(-5).join("\n") });
        }
        resolve({ ok: true, output: stdout });
      });
    });
  }
  function runReviewGit(args, { maxBuffer = 2 * 1024 * 1024 } = {}) {
    if (typeof injectedGitRunner === "function") return injectedGitRunner(args);
    return new Promise((resolve) => {
      execFile("git", ["-C", reviewRoot, ...args], { encoding: "utf8", timeout: 8000, maxBuffer }, (err, stdout) => {
        if (err) {
          const msg = String(err.message || "");
          if (msg.includes("not a git repository") || msg.includes("Not a git repository")) return resolve({ ok: false, isRepo: false, output: "" });
          if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer length exceeded/i.test(msg)) return resolve({ ok: false, isRepo: true, output: stdout || "", error: "output_too_large" });
          return resolve({ ok: false, isRepo: true, output: msg.split("\n").slice(-5).join("\n") });
        }
        resolve({ ok: true, output: stdout });
      });
    });
  }
  async function handleGitStatus(res) {
    const r = await runGit(["status", "--short", "--branch"]);
    json(res, 200, { isRepo: r.isRepo !== false, output: r.output || "" });
  }
  async function handleGitDiff(res) {
    const r = await runGit(["diff", "--stat"]);
    json(res, 200, { isRepo: r.isRepo !== false, output: r.output || "" });
  }

  // GET /api/git/review —— review-only repository snapshot for the workbench.
  // It intentionally reports state and never stages, resets, commits, or runs tests.
  async function handleGitReview(res) {
    const unknownVerification = { state: "unknown", checks: [] };
    const [statusResult, diffResult, numstatResult] = await Promise.all([
      runReviewGit(["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=normal"]),
      // 生成物较多时完整 diff 可能超过默认 2 MB；最终响应仍会收敛到 160 KB。
      runReviewGit(["diff", "--no-ext-diff", "--unified=3", "HEAD", "--"], { maxBuffer: 32 * 1024 * 1024 }),
      runReviewGit(["diff", "--no-ext-diff", "--numstat", "-z", "HEAD", "--"]),
    ]);
    if (statusResult.error) {
      return json(res, 200, { isRepo: statusResult.isRepo !== false, branch: null, files: [], diff: "", diffTruncated: false, error: statusResult.error, verification: unknownVerification });
    }
    if (statusResult.isRepo === false) {
      return json(res, 200, { isRepo: false, branch: null, files: [], diff: "", diffTruncated: false, verification: unknownVerification });
    }

    const records = String(statusResult.output || "").split("\0");
    const branchLine = records.find(record => record.startsWith("## ")) || "";
    const branch = branchLine.slice(3).split("...")[0] || null;
    const files = new Map();
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (!record || record.startsWith("## ") || record.length < 4 || record[2] !== " ") continue;
      const code = record.slice(0, 2);
      const filePath = record.slice(3);
      // Porcelain -z emits destination NUL original for a rename/copy.
      if (/[RC]/.test(code) && !records[++i]) continue;
      if (!filePath) continue;
      const status = code === "??" ? "untracked" : code.includes("D") ? "deleted" : code.includes("R") ? "renamed" : code.includes("A") ? "added" : "modified";
      files.set(filePath, { path: filePath, status, code, additions: 0, deletions: 0 });
    }
    const stats = String(numstatResult.output || "").split("\0");
    for (let i = 0; i < stats.length; i++) {
      const record = stats[i];
      const firstTab = record.indexOf("\t");
      const secondTab = record.indexOf("\t", firstTab + 1);
      if (firstTab < 0 || secondTab < 0) continue;
      const added = record.slice(0, firstTab);
      const removed = record.slice(firstTab + 1, secondTab);
      let filePath = record.slice(secondTab + 1);
      // Numstat -z emits counts TAB NUL original NUL destination.
      if (!filePath) { i++; filePath = stats[++i]; }
      if (!filePath) continue;
      const current = files.get(filePath) || { path: filePath, status: "modified", code: "  ", additions: 0, deletions: 0 };
      current.additions = /^\d+$/.test(added) ? Number(added) : null;
      current.deletions = /^\d+$/.test(removed) ? Number(removed) : null;
      files.set(filePath, current);
    }
    const rawDiff = String(diffResult.output || "");
    const maxDiffChars = 160_000;
    const diffTruncated = diffResult.error === "output_too_large" || rawDiff.length > maxDiffChars;
    const diff = diffTruncated ? rawDiff.slice(0, maxDiffChars) : rawDiff;
    return json(res, 200, {
      isRepo: true,
      root: reviewRoot,
      branch,
      files: [...files.values()].slice(0, 300),
      filesTotal: files.size,
      filesTruncated: files.size > 300,
      diff,
      diffTruncated,
      verification: createReviewVerification({ root: reviewRoot }).read(),
    });
  }

  return {
    scanRecentArtifacts, handlePrompts, handleSessionTree, handleSessionBranch,
    handleModelsRemove, handleSearch, handleAIBody, runGit, handleGitStatus, handleGitDiff, handleGitReview,
  };
}
