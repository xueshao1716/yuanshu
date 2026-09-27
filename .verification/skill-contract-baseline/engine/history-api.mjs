// engine/history-api.mjs —— 版本回溯（2026-09-20）
// 动机：敢让 agent 多动手的前提是"随时能退回去"。元枢其实一路都在留备份
//       （待审接受时留 .bak-apply、人格/技能同步留 .bak-persona、做梦/园丁留 .bak-*），
//       但界面上看不到、也没法一键回。这里把它们汇总成一个"回溯点"列表 + 一键回滚 + 审计。
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from 'node:crypto';
import { reviewPath, backupTarget, reviewAudit, reviewAtomicWrite } from './review-file-safety.mjs';

const MAX_ITEMS = 300;
const SKIP = /node_modules|\.git|dist|build|\.build-cache/;

function walk(root, out, depth = 0) {
  if (depth > 5 || out.length > MAX_ITEMS * 3) return;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP.test(e.name) || e.isSymbolicLink()) continue;
    const p = path.join(root, e.name);
    if (e.isDirectory()) { walk(p, out, depth + 1); continue; }
    if (/\.bak(-|$)/.test(e.name) || /\.bak$/.test(e.name)) {
      let st = null; try { st = fs.statSync(p); } catch {}
      out.push({ kind: "backup", backup: p, target: backupTarget(p), at: st ? new Date(st.mtimeMs).toISOString() : null, size: st ? st.size : 0 });
    }
  }
}

export function createHistoryApi({ wsRoot, json, readBody }) {
  const audit = (line) => reviewAudit(wsRoot, line);

  return {
    // GET /api/history —— 回溯点列表（备份文件 + 天团运行快照）
    async list(res) {
      const backups = [];
      walk(path.join(wsRoot, "工程"), backups);
      walk(path.join(wsRoot, "记忆"), backups);
      walk(path.join(wsRoot, 'workshop-out'), backups);
      backups.sort((a, b) => String(b.at).localeCompare(String(a.at)));
      // 天团/流水线运行快照（只读展示：产物在各自 runs/<id>/交付/ 里）
      let runs = [];
      try {
        const rroot = path.join(wsRoot, "工程", "多AI角色扮演系统", "runs");
        runs = fs.readdirSync(rroot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
          const dir = path.join(rroot, d.name);
          let files = [];
          try { files = fs.readdirSync(path.join(dir, "交付")); } catch {}
          let st = null; try { st = fs.statSync(dir); } catch {}
          return { id: d.name, dir, at: st ? new Date(st.mtimeMs).toISOString() : null, deliveries: files };
        }).sort((a, b) => String(b.at).localeCompare(String(a.at)));
      } catch {}
      return json(res, 200, {
        ok: true,
        backups: backups.filter(b => { try { reviewPath(wsRoot, path.relative(wsRoot, b.backup)); reviewPath(wsRoot, path.relative(wsRoot, b.target)); return true; } catch { return false; } }).slice(0, MAX_ITEMS).map((b) => ({ ...b, backup: path.relative(wsRoot, b.backup), target: path.relative(wsRoot, b.target) })),
        runs: runs.map((r) => ({ id: r.id, at: r.at, deliveries: r.deliveries })),
        note: "backups：一键回滚（当前内容会先另存 .bak-rollback-<时间>）；runs：只读快照，产物在各自 交付/ 目录",
      });
    },
    // POST /api/history/rollback { backup } —— 用备份覆盖目标（回滚前把当前内容再存一份）
    async rollback(res, body) {
      const rel = String(body?.backup || "");
      let backup, target;
      try { backup = reviewPath(wsRoot, rel); target = reviewPath(wsRoot, path.relative(wsRoot, backupTarget(backup))); } catch (e) { return json(res, 400, { error: e.message }); }
      if (!rel || !fs.existsSync(backup)) return json(res, 404, { error: "备份不存在：" + rel });
      if (!target || target === backup) return json(res, 400, { error: "无法从该文件名解析目标" });
      let written = false;
      try {
        audit({ at: new Date().toISOString(), kind: 'history-rollback-start', backup: rel });
        if (fs.existsSync(target)) fs.writeFileSync(target + ".bak-rollback-" + randomUUID(), fs.readFileSync(target), { flag: 'wx' });
        reviewAtomicWrite(target, fs.readFileSync(backup));
        written = true;
        audit({ at: new Date().toISOString(), kind: 'history-rollback', backup: rel, target: path.relative(wsRoot, target) });
      } catch { return json(res, 500, { error: written ? '文件已回滚，但审计未完成；请核对备份与记录，不要重复操作' : '回滚失败，未确认完成', recoveryRequired: written }); }
      return json(res, 200, { ok: true, rolledBack: path.relative(wsRoot, target), from: rel, note: "回滚前的内容已另存为 .bak-rollback-<时间>" });
    },
  };
}
