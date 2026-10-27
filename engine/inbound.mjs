// ===== inbound.mjs —— "向内管"的入口（2026-10-27）=====
//
// 用户说的「向内管、向外发」：向外发已经有 outbound.mjs；这里补向内管。
//
// 外部世界发生的事（群消息、邮件、价格变动、Webhook、监控告警）现在只能靠人转述，
// 元枢没有口子接。这一层把任意来源归一成一条事件，然后：
//   ① 落账（记忆/运行时/入站事件.json，环形 200 条）；
//   ② 和「我在盯的事」做关键词匹配——命中了才算"跟我有关"；
//   ③ 命中或高优先（mention/alert）→ 写进汇报台账，交给主动管理去追。
import fs from "node:fs";
import path from "node:path";
import { readState as readProactive } from "./proactive-manager.mjs";
import { enqueueReport } from "./job-state.mjs";

export const EVENTS_REL = path.join("记忆", "运行时", "入站事件.json");
export const MAX_EVENTS = 200;
export const SEVERITIES = ["low", "normal", "high"];

const fileOf = (ws) => path.join(String(ws || "."), EVENTS_REL);

export function readEvents(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(wsRoot), "utf8"));
    if (raw && Array.isArray(raw.items)) return raw;
  } catch {}
  return { v: 1, items: [] };
}

function writeEvents(wsRoot, data) {
  fs.mkdirSync(path.dirname(fileOf(wsRoot)), { recursive: true });
  fs.writeFileSync(fileOf(wsRoot), JSON.stringify({ ...data, v: 1, updatedAt: Date.now() }, null, 2), "utf8");
}

/** 与「在盯的事」做关键词匹配（标题 + keywords）。 */
export function matchWatches(text, watches = []) {
  const hay = String(text || "").toLowerCase();
  if (!hay) return [];
  return watches
    .filter((w) => w.status === "watching")
    .filter((w) => {
      const words = [...(w.keywords || []), w.title].filter(Boolean);
      return words.some((k) => String(k).length >= 2 && hay.includes(String(k).toLowerCase()));
    })
    .map((w) => ({ id: w.id, title: w.title }));
}

/**
 * 收一条外部事件。
 * @param {{wsRoot:string, source:string, kind?:string, text:string, severity?:string, at?:number, meta?:object}} p
 */
export function recvEvent({ wsRoot, source, kind = "info", text = "", severity = "normal", at = Date.now(), meta = {} } = {}) {
  const src = String(source || "").trim().slice(0, 40);
  const body = String(text || "").trim().slice(0, 2000);
  if (!src) return { ok: false, error: "source 不能为空" };
  if (!body) return { ok: false, error: "text 不能为空" };

  const watches = (readProactive(wsRoot).watches || []);
  const matched = matchWatches(body, watches);
  const sev = SEVERITIES.includes(severity) ? severity : "normal";
  const id = `in-${at.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const event = {
    id, at, source: src, kind: String(kind || "info").slice(0, 24),
    text: body, severity: sev, matched: matched.map((m) => m.title), meta: Object.keys(meta || {}).length ? meta : undefined,
  };

  const data = readEvents(wsRoot);
  data.items = [event, ...(data.items || [])].slice(0, MAX_EVENTS);
  writeEvents(wsRoot, data);

  // 命中我盯着的事，或本身就是高优先（被@/告警）→ 进汇报台账，交给主动管理
  let reported = false;
  if (matched.length || sev === "high" || kind === "mention" || kind === "alert") {
    try {
      enqueueReport(wsRoot, {
        id: `inbound-${id}`, kind: "inbound",
        label: `${src}${matched.length ? ` · ${matched.map((m) => m.title).join("、")}` : ""}`,
        state: sev === "high" ? "needs_attention" : "waiting",
        step: body.slice(0, 160),
        priority: sev === "high" ? "high" : "normal",
        at,
      });
      reported = true;
    } catch {}
  }

  return { ok: true, event, matched, reported };
}

export function listEvents(wsRoot, { limit = 20, source = "" } = {}) {
  const items = (readEvents(wsRoot).items || []);
  const filtered = source ? items.filter((i) => i.source === source) : items;
  return filtered.slice(0, Math.max(1, limit));
}

/** 环境事实一行：只在有新事件命中时提示。 */
export function inboundLine(wsRoot, { windowMs = 2 * 3600 * 1000, now = Date.now() } = {}) {
  const recent = (readEvents(wsRoot).items || []).filter((i) => now - (i.at || 0) <= windowMs);
  const hit = recent.filter((i) => (i.matched || []).length || i.severity === "high");
  if (!hit.length) return "";
  const head = hit.slice(0, 2).map((i) => `${i.source}：${String(i.text).slice(0, 24)}`).join("；");
  return `【外部事件】近 2 小时有 ${hit.length} 条跟你有关：${head}——在「接口台」里能看到。`;
}
