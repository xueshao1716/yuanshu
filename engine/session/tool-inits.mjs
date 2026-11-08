// ===== session/tool-inits.mjs —— pi 工具初始化器（2026-11-06 从 manager.mjs 抽出）=====
//
// 这 6 个初始化器只依赖三样外部输入：工作目录、pi 包路径、当场修执行器。
// 用工厂注入而不是读模块级变量，这样它们能独立存在，manager 只管转发。
import path from "node:path";
import { execActivateSkill } from "../context-loader.mjs";
import { wsSafePath } from "../workspace-api.mjs";
import { env } from "../env.mjs";
import { resolveShareOrigin } from "../network-endpoints.mjs";

export function createToolInitializers({ getCwd = () => "", getPiPackage = () => "", getFixRunner = () => null } = {}) {
  let searchToolDef = null, searchToolInit = null;
  let activateSkillToolDef = null;
  let piThinkToolDef = null, shareToolDef = null, piMediaTools = null, fixProblemToolDef = null;
  let verifyCheckToolDef = null;

  async function initSearchTool() {
  if (searchToolDef) return searchToolDef;
  try {
    // typebox 在 pi 引擎的依赖里，用 createRequire 从引擎路径解析
    const { createRequire } = await import("node:module");
    // 用 getPiPackage()（引擎入口路径，server 顶部已验证可用）解析 typebox
    const req2 = createRequire(getPiPackage());
    const { Type } = req2("typebox");
    const fb = await import("../filebox.mjs");
    searchToolDef = {
      name: "search_files",
      label: "搜索工作空间文件",
      description: "在本地工作空间搜索文件（按关键词/类型）。当用户要求发送/查看/交付某个文件、或不确定文件在哪时使用。搜索是本地执行的，速度快、结果准确。",
      promptSnippet: "用户要文件时，先用 search_files 找到准确路径，再用 📎 交付 标记交付",
      promptGuidelines: [
        "Use search_files when the user asks to send/deliver/find a file, or when you need a specific file's path.",
        "Pass the user's words as query (e.g. '酒店的ppt'), optionally types=['.ppt','.pptx'].",
        "After search, deliver the chosen file(s) with 📎 交付: <path> at the end of your reply.",
      ],
      parameters: Type.Object({
        query: Type.String({ description: "搜索关键词（用户原话或提取的关键词）" }),
        types: Type.Optional(Type.Array(Type.String({ description: "文件扩展名过滤，如 ['.png','.jpg']" }))),
      }),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const wsRoot = getCwd() || process.cwd();
        const files = fb.findFiles(wsRoot, { query: params.query || "", types: params.types || null, max: 10 });
        return {
          content: [{ type: "text", text: fb.findResultText(files, wsRoot) }],
          details: { files: files.map(f => ({ name: f.name, path: f.path })) },
        };
      },
    };
  } catch (e) {
    console.log(`[元枢] search_files 工具初始化失败: ${String(e?.message || e).slice(0, 80)}`);
  }
  return searchToolDef;
}

// 技能渐进式披露工具：统一引擎已有 activate_skill，Pi SDK 会话也必须注册同一能力。
// 之前只把技能摘要写进 system prompt，却没有把工具传给 AgentSession，模型于是把
// <tool_call> 当普通文本吐出，PPT 等需要技能正文的任务会停在计划阶段。
// 当场修（fix_problem）：执行器由 server 注入（它才知道用哪个模型、哪套工具跑执行轮）。

  async function initActivateSkillTool() {
  if (activateSkillToolDef) return activateSkillToolDef;
  try {
    const { createRequire } = await import("node:module");
    const req2 = createRequire(getPiPackage());
    const { Type } = req2("typebox");
    activateSkillToolDef = {
      name: "activate_skill",
      label: "加载技能",
      description: "加载技能全文和资源清单。用户任务匹配技能库摘要时调用；参数优先传 name，也兼容旧格式 skill。",
      promptSnippet: "匹配到技能时先调用 activate_skill 加载全文，再按技能执行",
      promptGuidelines: [
        "When a task matches a skill in the skill catalog, call activate_skill with its exact name before doing the work.",
        "For PPT requests, load ppt-generator or ppt-html, then execute the complete generation workflow and deliver the actual file.",
      ],
      parameters: Type.Object({
        name: Type.Optional(Type.String({ description: "技能名称，如 ppt-generator 或 ppt-html" })),
        skill: Type.Optional(Type.String({ description: "兼容旧调用：技能名称" })),
      }),
      async execute(toolCallId, params) {
        const name = String(params?.name || params?.skill || "").trim();
        if (!name) return { content: [{ type: "text", text: "缺少技能名称（请传 name）" }], isError: true };
        const result = execActivateSkill(name);
        return { content: [{ type: "text", text: result.text }], isError: !!result.isError };
      },
    };
  } catch (e) {
    console.log(`[元枢] activate_skill 工具初始化失败: ${String(e?.message || e).slice(0, 100)}`);
  }
  return activateSkillToolDef;
}

// 外部思考调试工具的 SDK 形态。server 里的 THINK_TOOL 是 OpenAI schema，不能直接
// 放进 Pi SDK customTools；转换后只在开启调试开关时注册，避免定义格式不匹配导致 agent 启动崩溃。

async function initPiThinkTool() {
  if (piThinkToolDef) return piThinkToolDef;
  try {
    const { createRequire } = await import("node:module");
    const req2 = createRequire(getPiPackage());
    const { Type } = req2("typebox");
    piThinkToolDef = {
      name: "think",
      label: "思考草稿",
      description: "调试用草稿工具，把动手前的分析写进 content；不会展示给用户或写入会话文件。",
      promptSnippet: "需要调试推理时调用 think 写下分析草稿",
      parameters: Type.Object({ content: Type.String({ description: "推理草稿" }) }),
      async execute(toolCallId, params) {
        return { content: [{ type: "text", text: "思考草稿已记录（仅调试，不展示给用户）" }], details: { thinking: String(params?.content || "") } };
      },
    };
  } catch (e) {
    console.log(`[元枢] think 工具初始化失败: ${String(e?.message || e).slice(0, 100)}`);
  }
  return piThinkToolDef;
}

// 外网分享工具：模型只需传项目路径，本地系统复制到外网分享目录并返回链接
// 模型永远不需要碰 cloudflared/隧道/端口——分享是自动的

  async function initShareTool() {
  if (shareToolDef) return shareToolDef;
  try {
    const { createRequire } = await import("node:module");
    const req2 = createRequire(getPiPackage());
    const { Type } = req2("typebox");
    shareToolDef = {
      name: "share_project",
      label: "外网分享项目",
      description: "把项目/网页分享到外网。当用户要求分享链接、外网访问、上线预览、给别人看时使用。只需传入项目路径，本地系统自动处理（复制到分享目录 + 返回公网链接），不需要也不应该手动操作 cloudflared/隧道/端口/DNS。",
      promptSnippet: "用户要分享/外链时，用 share_project 传入项目目录即可，勿动隧道",
      promptGuidelines: [
        "Use share_project when the user asks to share a project online, get a public link, or preview externally.",
        "Pass the project directory path (e.g. 工程/项目名 or 交付/xxx). Never touch cloudflared/config.yml/ports/DNS manually.",
        "The tool returns a public URL — show it to the user directly.",
      ],
      parameters: Type.Object({
        path: Type.String({ description: "要分享的项目目录或文件（工作空间相对路径），如 工程/贪吃蛇" }),
      }),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const src = params.path || "";
        const wsRoot = getCwd();
        const safe = wsSafePath(src);
        if (!safe || !fs.existsSync(safe)) {
          return { content: [{ type: "text", text: `项目不存在: ${src}。请先用 search_files 找到正确路径。` }] };
        }
        const shareDir = path.join(wsRoot, "外网分享");
        const origin = resolveShareOrigin({ host: env("SHARE_HOST"), agentDir: _getAgentDir() });
        if (!origin) return { content: [{ type: "text", text: "分享域名未配置或无效，未复制项目。请先在系统页登记外网分享域名。" }] };
        fs.mkdirSync(shareDir, { recursive: true });
        const base = path.basename(safe);
        const target = path.join(shareDir, base);
        // 复制到分享目录（目录递归复制，文件直接复制）
        try {
          if (fs.statSync(safe).isDirectory()) {
            // fs.cpSync 在 Windows Node 25 上会在包含图片的目录递归复制时触发
            // 进程级 0xC0000409；异步实现走稳定路径，错误也能回到工具结果。
            await fs.promises.cp(safe, target, { recursive: true, force: true });
          } else {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(safe, target);
          }
        } catch (e) {
          return { content: [{ type: "text", text: `复制失败: ${String(e?.message || e).slice(0, 80)}` }] };
        }
        const isHtml = fs.existsSync(path.join(target, "index.html"));
        const url = `${origin}/${encodeURIComponent(base)}${isHtml ? "/" : ""}`;
        return {
          content: [{ type: "text", text: `✅ 已分享到外网：${url}\n（项目已复制到 外网分享/${base}）` }],
          details: { url, path: `外网分享/${base}` },
        };
      },
    };
  } catch (e) {
    console.log(`[元枢] share_project 工具初始化失败: ${String(e?.message || e).slice(0, 80)}`);
  }
  return shareToolDef;
}


  async function initPiMediaTools() {
  if (piMediaTools) return piMediaTools;
  try {
    const { createRequire } = await import("node:module");
    const req2 = createRequire(getPiPackage());
    const { Type } = req2("typebox");
    const { createPiMediaTools } = await import("../pi-media-tools.mjs");
    piMediaTools = createPiMediaTools({
      Type,
      generateMediaAsync: _generateMediaAsync,
      getModelList: _getModelList,
    });
  } catch (e) {
    console.log(`[元枢] 宿主媒体工具初始化失败: ${String(e?.message || e).slice(0, 80)}`);
    piMediaTools = [];
  }
  return piMediaTools;
}


  async function initFixProblemTool() {
  if (fixProblemToolDef) return fixProblemToolDef;
  if (typeof getFixRunner() !== "function") return null; // 没注入执行器就不注册（fail-closed）
  try {
    const { createRequire } = await import("node:module");
    const req2 = createRequire(getPiPackage());
    const { Type } = req2("typebox");
    fixProblemToolDef = {
      name: "fix_problem",
      label: "当场修",
      // 2026-11-08 真事故：伙伴让"核实截图里微信搜索是否搜到某人"，模型把它包成 fix_problem，
      // 于是派了一个完整执行轮进那个目录——探测脚本 import 就崩，命令连续失败、交付门一直 RED、
      // 一轮轮重试，看起来像卡住。描述必须写清适用边界，并给出观察类任务的替代做法。
      description: "只用来修一个**已经定位到、能当场改代码/配置/文档修掉**的问题：派一个完整执行轮去改、跑验证、拿证据。**观察类任务不要用**——「看一眼/核实/确认截图或图片里是什么、有没有、是不是」不是修，是看：直接看那张图（或读文件）后在同一轮里回答，不要派执行轮；误用会被前置拒绝，白耗一次调用。需要人拍板的事（权限/密钥/部署/推送/删数据/花钱）不要用它——写进结论交给用户。同一会话 10 分钟内最多 3 次。",
      promptSnippet: "只修已定位、能当场改的问题；看一眼/核实/确认图里的内容是观察任务——直接看图回答，别调 fix_problem",
      promptGuidelines: [
        "Only call fix_problem when the problem is already located and can be fixed by editing code/config/docs in this workspace right now. It dispatches a full execution turn with tools — it is not a way to look at something.",
        "NEVER call it to observe/verify/confirm what is in an image or screenshot (e.g. 'check whether the WeChat search found this person', 'look at this screenshot'). Read the image yourself and answer directly in the same turn.",
        "Never use fix_problem for things needing human approval (permissions, secrets, deploys, pushes, deleting data, spending money) — report those instead.",
        "Observation-type problems, and the same problem after two RED attempts in 10 minutes, are refused before any turn runs. Do not retry them — fix the environment or switch workspace directory instead.",
      ],
      parameters: Type.Object({
        problem: Type.String({ description: "要当场修什么，一句话，具体到可核查（≤60 字）。必须是能动手改的问题；观察/核实类（截图里有没有、图里是什么）不要用这个工具。" }),
      }),
      async execute(toolCallId, params, ctx) {
        const out = await getFixRunner()({
          problem: params?.problem,
          sessionKey: ctx?.sessionKey || ctx?.sessionId || "anon",
        });
        return { content: [{ type: "text", text: String(out?.text || "（没有结果）") }], isError: !out?.ok };
      },
    };
    return fixProblemToolDef;
  } catch (e) {
    console.log(`[元枢] fix_problem 工具初始化失败: ${String(e?.message || e).slice(0, 80)}`);
    return null;
  }
}


// 断言闸门（2026-11-09，verify-gate）：Pi 通道也要有同一个 verify_check。
// 元枢最贵的幻觉不是"活干错了"，是"话里的数字没核过"——所以这个工具的使用场景必须写死：
// **报数之前用**（数量/存在性/路径/大小/测试结果），不是"另一个跑测试的工具"。
// 结果只回给模型，不推聊天：验证是后台动作，不是回复内容。
  async function initVerifyCheckTool() {
  if (verifyCheckToolDef) return verifyCheckToolDef;
  try {
    const { createRequire } = await import("node:module");
    const req2 = createRequire(getPiPackage());
    const { Type } = req2("typebox");
    const { createVerifyCheckExecutor, VERIFY_CHECK_TOOL } = await import("../tools/verify-check.mjs");
    const { ASSERTION_TYPES, COUNT_OPS, MAX_CLAIMS } = await import("../claim-verify.mjs");
    const exec = createVerifyCheckExecutor({ cwd: getCwd, roots: () => [getCwd()], maxClaims: MAX_CLAIMS });
    verifyCheckToolDef = {
      name: "verify_check",
      label: "断言闸门",
      // 适用场景写在第一句：「报数之前用」。先说清什么时候用，再说参数，
      // 否则它会被当成"想跑测试时才调"的工具，而真正该过闸的"我查过了"永远不过闸。
      description: "报数之前用：把你要说出口的数字/存在性/路径/大小/测试结果落成断言，逐条比对事实（文件在不在、目录几项、命令输出几行、文件多少字节）。"
        + "要说「一共 N 项 / 我查过了 / 文件在里面 / 测试全过 / 生成物有 M 个」之前先跑它；一次最多 8 条。"
        + "有一条 ❌ 就不许说完成：换成实际数字，或如实说没查到。命令类断言会真的执行命令（仍过宪法红线与危险命令拦截），路径只能看工作区内的。"
        + "结果只给你自己核对，不会推给用户——验证是后台动作，别提断言清单，只说结论。",
      promptSnippet: "报数之前（数量/存在性/路径/大小/测试结果）先 verify_check 落断言；有一条 FAIL 就不许说完成",
      promptGuidelines: [
        "Before stating any count, existence, path, file size or test result, call verify_check with atomic claims — do not report numbers from impression.",
        "Pass at most 8 claims per call; command-backed claims are really executed and still pass the constitution deny rules and dangerous-command block.",
        "If any claim comes back ❌, do not say the work is done: state the actual number, or say plainly that you could not verify it.",
        "The result is for your own checking — never paste the assertion list or raw verification output to the user; only the conclusion.",
      ],
      parameters: Type.Object({
        claims: Type.Array(Type.Object({
          kind: Type.String({ enum: ASSERTION_TYPES, description: "EXISTS / NOT_EXISTS / COUNT / CONTAINS / LINE_EQ / LINE_INCLUDES / SIZE_GT / SIZE_EQ" }),
          target: Type.Optional(Type.String({ description: "路径（文件或目录，工作区内）；COUNT 数目录条目/文件行数/匹配数时也用它" })),
          command: Type.Optional(Type.String({ description: "可选：用命令输出当事实来源（会真的执行，仍过红线与危险命令拦截）" })),
          expected: Type.Optional(Type.String({ description: "期望值：COUNT/SIZE_* 是数字；CONTAINS/LINE_* 是要找的文字" })),
          op: Type.Optional(Type.String({ enum: COUNT_OPS, description: "COUNT 的比较方式，默认 ==" })),
          line: Type.Optional(Type.Number({ description: "LINE_EQ / LINE_INCLUDES 用：第几行（从 1 开始）" })),
          match: Type.Optional(Type.String({ description: "可选：COUNT 时数这段文字出现几次；target 是目录时按文件名包含匹配" })),
        }), { maxItems: MAX_CLAIMS, description: `断言列表，最多 ${MAX_CLAIMS} 条` }),
      }),
      async execute(toolCallId, params) {
        const out = await exec(params || {});
        return { content: [{ type: "text", text: String(out?.text || "（没有结果）") }], isError: !!out?.isError };
      },
    };
  } catch (e) {
    console.log(`[元枢] verify_check 工具初始化失败: ${String(e?.message || e).slice(0, 100)}`);
    verifyCheckToolDef = null;
  }
  return verifyCheckToolDef;
}


  return {
    initSearchTool, initActivateSkillTool, initPiThinkTool, initShareTool, initPiMediaTools, initFixProblemTool, initVerifyCheckTool,
    peekSearchToolDef: () => searchToolDef,
  };
}
