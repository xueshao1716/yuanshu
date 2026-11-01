// 任务列表过滤（服务端）：跳页带条件时用，纯函数好测
import path from "node:path";

/** day 词 → 天数（today/yesterday 由日期判断，week=7, month=30, recentN=N） */
export function dayWindow(day) {
  const d = String(day || "");
  if (!d) return null;
  if (d === "today") return { kind: "today" };
  if (d === "yesterday") return { kind: "yesterday" };
  const days = d === "week" ? 7 : d === "month" ? 30 : Number(d.replace("recent", "")) || 1;
  return { kind: "days", days };
}

export function withinDay(iso, day, now = Date.now()) {
  const win = dayWindow(day);
  if (!win) return true;
  const t = Date.parse(String(iso || ""));
  if (!Number.isFinite(t)) return false;
  if (win.kind === "today") return new Date(t).toDateString() === new Date(now).toDateString();
  if (win.kind === "yesterday") {
    const y = new Date(now); y.setDate(y.getDate() - 1);
    return new Date(t).toDateString() === y.toDateString();
  }
  return now - t <= win.days * 86400000;
}

/**
 * 过滤任务列表。
 * @param {any[]} tasks
 * @param {{day?:string, q?:string, now?:number}} opts
 */
export function filterTasks(tasks = [], { day = "", q = "", now = Date.now() } = {}) {
  const needle = String(q || "").trim().toLowerCase();
  return (Array.isArray(tasks) ? tasks : []).filter((t) => {
    if (!withinDay(t?.lastRun || t?.lastStart, day, now)) return false;
    if (needle && !`${t?.label || ""}${t?.prompt || ""}`.toLowerCase().includes(needle)) return false;
    return true;
  });
}
