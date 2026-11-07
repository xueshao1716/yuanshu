// ===== watchdog-read.mjs —— 让模型答得上「刚才哪件事跑偏了」（2026-11-07）=====
//
// 看门狗推送飞出去一条通知，用户追问「哪个任务」时模型手里没有可查的东西：
// 判定台账只有 code/detail、没有 id。这里给一个**只读**工具：
//   watchdog_read           → 最近一条事件
//   watchdog_read {id}      → 指定事件
// 输出是模型能直接转述的中文（哪一轮、哪个工具、失败成什么样、去哪看），不是 JSON。
// 它不会停任务、不会改任何东西；真正收尾要用户明确说「停」。
import { getDriftIncident, latestDriftIncident } from "../watchdog-incidents.mjs";

export const WATCHDOG_READ_TOOL = {
  type: "function",
  function: {
    name: "watchdog_read",
    description: "查最近一次（或指定 id 的）看门狗「跑偏」事件：哪件事（任务名）、哪一轮/哪个会话、哪个工具、失败成了什么样、去哪里看。"
      + "用户问「刚才哪件事跑偏了」「哪个任务出问题了」「看门狗报的是什么」时先调它，再用自然语言回答。"
      + "只读，不会停任务；返回一段可直接转述的中文摘要。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "事件 id（推送正文里的 drift-…）；不填 = 最近一条" },
      },
    },
  },
};

const text = (v) => (v == null ? "" : String(v).trim());

function clock(ms) {
  const d = new Date(Number(ms));
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** run/session 的 uuid 口头转述只用前 8 位；完整 id 单独列在末尾。 */
function shortId(id) {
  const s = text(id);
  return s.length > 12 ? s.slice(0, 8) : s;
}

/** 把一条 issue 写成两句人话：哪一轮（有名字先说名字）+ 最近一次长什么样。 */
function issueSentence(issue) {
  const detail = text(issue?.detail || issue?.reason || issue?.code) || "有一处偏离";
  const samples = Array.isArray(issue?.samples) ? issue.samples.filter(Boolean) : [];
  const latest = samples[0]
    ? `\n  最近一次是 ${text(samples[0])}。`
    : "\n  （没留到失败输出，只能看到次数）";
  const start = Number(issue?.startedAt || issue?.firstAt || 0);
  const first = Number(issue?.firstAt || 0);
  const last = Number(issue?.lastAt || 0);
  const more = Array.isArray(issue?.runIds) && issue.runIds.length > 1 ? `，另有 ${issue.runIds.length - 1} 轮` : "";
  // run 记录里的 title（看门狗判定时已解析好）；没有就照旧只报 id/会话。
  const title = text(issue?.title);
  const named = title ? `，任务「${title}」` : "";

  if (issue?.runId) {
    const session = issue?.sessionId ? `，会话 ${shortId(issue.sessionId)}` : "";
    return `${start ? clock(start) : "时间不明"} 开始的那一轮（run ${shortId(issue.runId)}${named}${session}${more}）里，${detail}。${latest}`;
  }
  if (issue?.sessionId) {
    return `${start ? clock(start) : "时间不明"} 开始的那一轮（会话 ${shortId(issue.sessionId)}${named}${more}）里，${detail}。${latest}`;
  }
  if (issue?.taskId) {
    return `${start ? clock(start) : "时间不明"} 开始的那一轮（任务 ${issue.taskId}${named}${more}）里，${detail}。${latest}`;
  }
  const range = first
    ? (last && last - first > 60_000 ? `${clock(first)}–${clock(last)}` : clock(first))
    : "时间不明";
  if (title) {
    return `${range} 那一段（任务「${title}」，这轮没带 id，只能按时间对）里，${detail}。${latest}`;
  }
  return `${range} 那一段（这轮没带 id，只能按时间对）里，${detail}。${latest}`;
}

/** 事件 → 可转述的中文摘要。导出给测试与其它只读入口复用。 */
export function formatIncidentForModel(incident) {
  if (!incident) return "最近没有看门狗跑偏事件（记忆/运行时/看门狗事件.json 里还没有记录）。";
  const issues = Array.isArray(incident.issues) ? incident.issues : [];
  const lines = [`看门狗在 ${clock(incident.at)} 记到 ${issues.length} 个可能跑偏的问题：`];
  for (const issue of issues.slice(0, 3)) lines.push(`· ${issueSentence(issue)}`);

  const ids = [];
  for (const issue of issues.slice(0, 3)) {
    const parts = [];
    if (issue?.runId) parts.push(`run ${issue.runId}`);
    if (issue?.sessionId) parts.push(`会话 ${issue.sessionId}`);
    if (issue?.taskId) parts.push(`任务 ${issue.taskId}`);
    if (parts.length) ids.push(parts.join("，"));
  }
  if (ids.length) lines.push(`完整 id：${[...new Set(ids)].join("；")}。`);
  lines.push(`事件 id：${incident.id}`);
  lines.push(`详情：GET /api/watchdog/drift/${encodeURIComponent(incident.id)}`);
  lines.push("（看门狗只提醒、没有停任务；用户明确说「停」再收尾。）");
  return lines.join("\n");
}

/** 生成 watchdog_read 执行器。wsRoot 在调用时传入（默认工作区）。 */
export function createWatchdogReadExecutors({ wsRoot = "." } = {}) {
  return {
    watchdog_read: (args = {}) => {
      const id = text(args?.id);
      if (id) {
        const incident = getDriftIncident(wsRoot, id);
        if (!incident) {
          return {
            text: `没找到 id 为 ${id} 的看门狗事件。可能已经超过最近 50 条被清掉了，或 id 抄错了；不填 id 调 watchdog_read 可以看最近一条。`,
            isError: true,
          };
        }
        return { text: formatIncidentForModel(incident), isError: false };
      }
      const incident = latestDriftIncident(wsRoot);
      if (!incident) {
        return { text: "最近没有看门狗跑偏事件（记忆/运行时/看门狗事件.json 里还没有记录）。", isError: false };
      }
      return { text: formatIncidentForModel(incident), isError: false };
    },
  };
}
