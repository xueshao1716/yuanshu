// 修复关系读数（2026-11-10 P0-1 的善后）
//
// 背景：旧逻辑把"命令非零退出"判成关系负向（trust −0.08，正面才 +0.03），
// 实测把 trust 打到了 0.0144 —— 那不是真实关系，是 bug 的产物。
// 代码已修，但已写坏的数不会自己涨回来（正面还要过 (1-trust)/0.75 的软化）。
//
// 这个脚本做两件事，**默认 dry-run，只打印将要做什么**：
//   1. trust 恢复到默认基线（没被 bug 打穿过就什么都不做）
//   2. 清掉 notes 里由"工具失败"生成的条目（"4 次工具失败"这类），保留人写的备注
//
// 用法：
//   node scripts/repair-relationship.mjs              # 看
//   node scripts/repair-relationship.mjs --apply      # 改（先备份到 backups/）
import fs from "node:fs";
import path from "node:path";

const WS_ROOT = process.env.YS_WS_ROOT || "D:\\pi-workspace";
const REL = path.join(WS_ROOT, "记忆", "运行时", "关系.json");
const BASELINE_TRUST = 0.25;
// 旧 bug 生成的备注长这样："4 次工具失败""6 次工具失败"
const BUG_NOTE_RE = /^\s*\d+\s*次工具失败/;

function main() {
  const apply = process.argv.includes("--apply");
  if (!fs.existsSync(REL)) {
    console.log(`[repair] 没有关系文件：${REL}（未初始化，不需要修）`);
    return;
  }
  const raw = fs.readFileSync(REL, "utf8");
  const state = JSON.parse(raw);
  const trust = Number(state.trust);
  const notes = Array.isArray(state.notes) ? state.notes : [];
  const badNotes = notes.filter((n) => BUG_NOTE_RE.test(String(n?.text ?? n ?? "")));
  const trustBroken = Number.isFinite(trust) && trust < BASELINE_TRUST;

  console.log(`[repair] 文件：${REL}`);
  console.log(`[repair] trust=${trust}${trustBroken ? ` → 将恢复到 ${BASELINE_TRUST}` : "（正常，不动）"}`);
  console.log(`[repair] notes ${notes.length} 条，其中 ${badNotes.length} 条由工具失败生成${badNotes.length ? "（将清除）" : ""}`);
  for (const n of badNotes.slice(0, 5)) console.log(`  · ${String(n?.text ?? n).slice(0, 60)}`);

  if (!trustBroken && badNotes.length === 0) {
    console.log("[repair] 无需要修复的内容。");
    return;
  }
  if (!apply) {
    console.log("[repair] dry-run：没有写任何文件。确认无误后加 --apply。");
    return;
  }

  const next = {
    ...state,
    trust: trustBroken ? BASELINE_TRUST : trust,
    notes: notes.filter((n) => !BUG_NOTE_RE.test(String(n?.text ?? n ?? ""))).slice(-20),
    repairedAt: Date.now(),
    repairNote: "2026-11-10 P0-1：trust 由工具失败误判打穿，已恢复到基线",
  };

  // 先备份，再原子写
  const backupDir = path.join(WS_ROOT, "backups", `repair-relationship-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(REL, path.join(backupDir, "关系.json"));
  const tmp = `${REL}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, REL);

  console.log(`[repair] 已修复：trust=${next.trust}，notes ${notes.length} → ${next.notes.length}`);
  console.log(`[repair] 备份：${backupDir}`);
}

main();
