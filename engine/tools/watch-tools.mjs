// ===== watch-tools.mjs —— 值班程序对模型的四个工具（2026-11-07）=====
//
// watch_create / watch_list / watch_pause / watch_delete。
// 和 engine/tools/ 里其它工具一样是 OpenAI function 格式；执行体只做参数校验与转调，
// 真正的判定、限流、沙箱策略在 engine/watch-duty.mjs。
//
// 能力定位：值守是**确定性检查**（命令/HTTP/文件/到点），不花模型；只有命中并且过了冷却、
// 每日上限、免打扰、主动预算之后，才唤醒我跑一轮 prompt。所以这里的成本描述必须写清楚，
// 否则模型会以为"建一条 watch = 每隔几分钟烧一次钱"，从而不敢用。

export const WATCH_CREATE_TOOL = {
  type: "function",
  function: {
    name: "watch_create",
    description: "建一条值班：长期盯一件事，只有真的命中才唤醒你，平时不调用模型。"
      + "适合「等 CI 挂了告诉我」「这个页面出 500 叫我」「文件一改就提醒」「每天早上到点处理」。"
      + "命中后你会被叫醒跑 prompt；同时最多 10 条活跃，检查间隔最短 60 秒。"
      + "命令要过现有沙箱与红线（deny 优先），只读命令为主。"
      + "唤醒轮默认只给最小只读工具集（read/search_files/web_search/read_url + notify_user 等回执工具），"
      + "默认不给 write/edit/bash/pwsh/dsh_task/媒体生成；确实需要写操作时，用 allowTools 显式列出工具名（仍要过沙箱与红线）。"
      + "服务重启后会按状态文件恢复；0–7 点免打扰期间命中的，7 点后按时间顺序补跑（每天最多 3 条，仍过冷却/日限/预算）。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "一句话名字，会出现在通知和日志里（如「CI 挂了」）" },
        kind: { type: "string", enum: ["cmd", "http", "file", "time"], description: "盯什么：cmd 命令退出码、http 网址状态码/正文、file 文件变化、time 到点" },
        spec: {
          type: "object",
          description: "判定规则，按 kind 填：cmd 用 command；http 用 url；file 用 path；time 用 type/at。",
          properties: {
            command: { type: "string", description: "cmd：要跑的命令（只读为主，会过沙箱与红线）" },
            expectExit: { type: "number", description: "cmd：期望退出码，默认 0；也可传数组表示都算命中" },
            stdoutIncludes: { type: "string", description: "cmd：输出里必须包含这段文字才算命中（可选）" },
            stdoutRegex: { type: "string", description: "cmd：输出要匹配的正则（可选，如 \"FAIL\\\\s+\\\\d+\"）" },
            stderrIncludes: { type: "string", description: "cmd：stderr 必须包含这段文字（可选）" },
            url: { type: "string", description: "http：要 GET 的网址（http/https）" },
            expectStatus: { type: "number", description: "http：期望状态码，默认 200；可传数组" },
            contains: { type: "string", description: "http：正文必须包含的关键字；file：mode=contains 时要找的关键字" },
            notContains: { type: "string", description: "http：正文不能出现的关键字（可选）" },
            path: { type: "string", description: "file：要盯的文件（相对工作区或绝对路径）" },
            mode: { type: "string", enum: ["changed", "appeared", "disappeared", "contains", "size_gt"], description: "file：判定方式，默认 changed（mtime/大小变了）；首次观察只建基线不触发" },
            sizeGt: { type: "number", description: "file：mode=size_gt 时的字节阈值" },
            type: { type: "string", enum: ["daily", "weekly", "once"], description: "time：每天/每周/一次，默认 daily" },
            at: { type: "string", description: "time：HH:MM（如 09:00）" },
            day: { type: "number", description: "time：type=weekly 时星期几（1-7，周一=1）" },
            date: { type: "string", description: "time：type=once 时日期 YYYY-MM-DD" },
          },
        },
        prompt: { type: "string", description: "命中后要跑的那句话，写给未来的自己看，要能独立执行" },
        intervalMs: { type: "number", description: "检查间隔（毫秒），最小 60000，默认 300000（5 分钟）" },
        cooldownMs: { type: "number", description: "两次唤醒的最小间隔（毫秒），默认 1800000（30 分钟）" },
        dailyCap: { type: "number", description: "这条值班每天最多唤醒几次，默认 12，上限 100" },
        allowTools: {
          type: "array",
          items: { type: "string" },
          description: "可选：唤醒这一轮允许使用的工具名白名单。不填 = 默认最小只读集（read/search_files/grep/glob/web_search/read_url + notify_user 等回执工具），"
            + "不给 write/edit/bash/pwsh/dsh_task/媒体生成。显式填写（如 [\"read\",\"bash\"]）才按它给，且仍要过沙箱与红线；空数组 = 这一轮不给任何工具。",
        },
      },
      required: ["name", "kind", "spec", "prompt"],
    },
  },
};

export const WATCH_LIST_TOOL = {
  type: "function",
  function: {
    name: "watch_list",
    description: "列出所有值班：状态、检查间隔、最近检查/命中/唤醒时间、今天唤醒次数、下次检查时间。判断哪些该暂停或删掉时用它。",
    parameters: { type: "object", properties: {} },
  },
};

export const WATCH_PAUSE_TOOL = {
  type: "function",
  function: {
    name: "watch_pause",
    description: "暂停或恢复一条值班。暂停不删除，恢复后从当前时间重新计时。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "值班 id（watch_list 里能看到）" },
        paused: { type: "boolean", description: "true=暂停（默认），false=恢复" },
      },
      required: ["id"],
    },
  },
};

export const WATCH_DELETE_TOOL = {
  type: "function",
  function: {
    name: "watch_delete",
    description: "删除一条值班（不再检查）。只是暂时不想盯就用 watch_pause。",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "值班 id" } },
      required: ["id"],
    },
  },
};

export const WATCH_TOOLS = [WATCH_CREATE_TOOL, WATCH_LIST_TOOL, WATCH_PAUSE_TOOL, WATCH_DELETE_TOOL];

const fmtTime = (ms) => (ms ? new Date(Number(ms)).toLocaleString("zh-CN", { hour12: false }) : "—");

/** 生成四个工具的执行器。getDuty 晚绑定（server 启动时才创建值班实例）。 */
export function createWatchToolExecutors({ getDuty } = {}) {
  const dutyOrError = () => {
    const d = typeof getDuty === "function" ? getDuty() : getDuty;
    return d || null;
  };
  return {
    watch_create: (args = {}) => {
      const d = dutyOrError();
      if (!d) return { text: "值班程序还没初始化（服务刚启动或初始化失败），稍后再试。", isError: true };
      const out = d.create(args);
      if (!out.ok) return { text: `建不了这条值班：${out.error}`, isError: true };
      const w = out.watch || {};
      const tools = Array.isArray(w.allowTools)
        ? (w.allowTools.length ? `显式白名单：${w.allowTools.join("、")}` : "空数组：唤醒轮不给任何工具")
        : "默认最小只读集（read/search_files/web_search/read_url + notify_user 等）";
      return {
        text: [
          `已建值班 ${out.id}「${w.name}」（${w.kind}）：每 ${Math.round((w.intervalMs || 0) / 1000)} 秒做一次确定性检查，不花模型；`,
          `命中后才会叫醒我，冷却 ${Math.round((w.cooldownMs || 0) / 60000)} 分钟、每天最多 ${w.dailyCap} 次，推送还要过主动预算。`,
          `唤醒工具：${tools}。0–7 点免打扰命中的，7 点后补跑（每天最多 3 条）。`,
          ...(out.notes || []),
        ].join(""),
        isError: false,
      };
    },
    watch_list: () => {
      const d = dutyOrError();
      if (!d) return { text: "值班程序还没初始化。", isError: true };
      const rows = d.list();
      if (!rows.length) return { text: "现在没有任何值班。要长期盯一件事就用 watch_create。", isError: false };
      const data = rows.map((w) => {
        const s = w.runtime || {};
        return `- ${w.id}「${w.name}」${w.kind} · ${w.state === "active" ? "在盯" : "已暂停"}`
          + ` · 每 ${Math.round(w.intervalMs / 1000)}s 检查`
          + ` · 最近检查 ${fmtTime(s.lastCheckAt)}`
          + ` · 最近命中 ${fmtTime(s.lastHitAt)}`
          + ` · 今天唤醒 ${w.wakesToday}/${w.dailyCap}`
          + ` · 下次 ${fmtTime(w.nextCheckAt)}`
          + (s.last?.suppressed ? ` · 上次被拦：${s.last.suppressed}` : "");
      });
      const sm = d.summary();
      return { text: `${sm.active}/${sm.total} 条在盯（上限 ${sm.maxActive}）\n${data.join("\n")}`, isError: false };
    },
    watch_pause: (args = {}) => {
      const d = dutyOrError();
      if (!d) return { text: "值班程序还没初始化。", isError: true };
      const id = String(args?.id || "");
      if (!id) return { text: "要暂停哪一条？给我 id（watch_list 里能看到）。", isError: true };
      const out = args?.paused === false ? d.resume(id) : d.pause(id);
      if (!out.ok) return { text: out.error || "操作失败", isError: true };
      return { text: `${id} 已${out.state === "paused" ? "暂停" : "恢复"}。`, isError: false };
    },
    watch_delete: (args = {}) => {
      const d = dutyOrError();
      if (!d) return { text: "值班程序还没初始化。", isError: true };
      const id = String(args?.id || "");
      if (!id) return { text: "要删哪一条？给我 id。", isError: true };
      const out = d.remove(id);
      if (!out.ok) return { text: out.error || "删除失败", isError: true };
      return { text: `已删除值班 ${id}。`, isError: false };
    },
  };
}
