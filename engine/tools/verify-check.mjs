// ===== verify-check.mjs —— verify_check：开口报数之前的断言闸门（2026-11-09）=====
//
// 来源：曦（xinyu-hermes）skills/verify-gate。元枢最贵的一类幻觉不是"活干错了"，是
// **话里的事实没核过**：没查就说查了、没数就报 92 项、文件不在也说在里面、测试挂了也说全过。
// 交付门（delivery_check）管的是"改动有没有验证覆盖"，管不到这些；这个工具补的就是那一段。
//
// 定位（必须写进描述，否则模型会把它当"另一个跑测试的工具"）：
//   · 报数之前用：把结论拆成原子断言，逐条比对文件/命令输出/字节数
//   · 结果只回给模型，不推聊天——静默是这套闸门的规矩（验证是后台动作，不是回复内容）
//   · 一条 FAIL 就不许说完成：要么改实际数字，要么说没查到
//
// 安全边界全在 engine/claim-verify.mjs：命令走注入 run（默认 execFile）并过
// matchDenyRule / DANGEROUS_CMD_RE；路径必须落在允许根内（工作区 + 系统本体）。
import { runClaims, formatClaimReport, MAX_CLAIMS, ASSERTION_TYPES, COUNT_OPS } from "../claim-verify.mjs";

const CLAIM_ITEM = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ASSERTION_TYPES,
      description: "断言类型：EXISTS 在不在 / NOT_EXISTS 确实不在 / COUNT 数量 / CONTAINS 含不含 / "
        + "LINE_EQ 第 N 行等于 / LINE_INCLUDES 第 N 行包含 / SIZE_GT 大于多少字节 / SIZE_EQ 等于多少字节",
    },
    target: { type: "string", description: "路径（文件或目录，相对工作区或允许根内的绝对路径）。COUNT 数目录条目、文件行数或匹配数时也用 target。" },
    command: { type: "string", description: "可选：用命令输出当事实来源（COUNT 数输出行数/匹配数，CONTAINS 在输出里找，LINE_* 按输出行号）。会真的执行，仍过宪法红线与危险命令拦截。" },
    expected: { type: "string", description: "期望值：COUNT/SIZE_* 是数字（写成字符串也行，如 \"92\"）；CONTAINS/LINE_* 是要找的文字；EXISTS/NOT_EXISTS 不用给。" },
    op: { type: "string", enum: COUNT_OPS, description: "COUNT 的比较方式，默认 ==。" },
    line: { type: "number", description: "LINE_EQ / LINE_INCLUDES 用：第几行（从 1 开始）。" },
    match: { type: "string", description: "可选：COUNT 时数「这段文字出现几次」而不是数行数；target 是目录时按文件名包含匹配。" },
  },
  required: ["kind"],
};

export const VERIFY_CHECK_TOOL = {
  type: "function",
  function: {
    name: "verify_check",
    description: "报数之前用：把你准备说出口的数字/存在性/路径/大小/测试结果落成断言，逐条比对事实（文件是否存在、目录几项、命令输出几行、文件多少字节），返回每条 ✅/❌ 和汇总。"
      + "要说「一共 N 项 / 我查过了 / 文件在里面 / 测试全过 / 生成物有 M 个」之前先跑它；一次最多 8 条断言。"
      + "命令类断言（COUNT / CONTAINS / LINE_* 里带 command）会真的执行命令，仍过宪法红线与危险命令拦截；路径类断言只能看工作区与系统目录内的路径，越界直接判失败；凭据文件（auth.json/.env/.token 等）不参与断言。"
      + "**有一条 ❌ 就不许说完成**：把实际数字说出来，或如实说没查到。结果只回给你自己核对，不会推给用户。",
    parameters: {
      type: "object",
      properties: {
        claims: {
          type: "array",
          description: `要核对的断言，最多 ${MAX_CLAIMS} 条。例：[{"kind":"EXISTS","target":"生成物/图片/x.png"},{"kind":"COUNT","target":"生成物/图片","op":"==","expected":"92"}]`,
          items: CLAIM_ITEM,
        },
      },
      required: ["claims"],
    },
  },
};

/**
 * 闸门的只读状态（GET /api/tools/verify-check 用）。
 *
 * 没有可写开关：这个工具常开，边界写死在下面的 schema 里；这里只是把边界摆出来给人看。
 * 也**不落盘**——核对结果只回给模型，所以没有"历史条目"可读（如实写在这里，不编一个）。
 */
export const VERIFY_CHECK_STATUS = Object.freeze({
  name: "verify_check",
  alwaysOn: true,
  persistsResults: false,
  maxClaims: MAX_CLAIMS,
  assertionTypes: Object.freeze([...ASSERTION_TYPES]),
  countOps: Object.freeze([...COUNT_OPS]),
});

/**
 * 造一个 verify_check 执行器。
 * @param {object} opts
 *   cwd     工作目录（默认 process.cwd）；同时作为命令执行目录与第一个允许根
 *   roots   允许读的根（默认 [cwd]）。越界路径直接判失败，不静默改路径
 *   run     注入的命令执行器（默认 engine/claim-verify.mjs 的 execFile 实现）
 */
export function createVerifyCheckExecutor({ cwd = () => process.cwd(), roots = null, run = null, maxClaims = MAX_CLAIMS } = {}) {
  return async function executeVerifyCheck(args = {}) {
    const base = typeof cwd === "function" ? cwd() : (cwd || process.cwd());
    const claimList = Array.isArray(args?.claims) ? args.claims : (args?.claim ? [args.claim] : []);
    if (args?.claims !== undefined && !Array.isArray(args.claims)) {
      return { text: "⛔ verify_check 需要 claims 数组（每条一个断言，最多 8 条）", isError: true };
    }
    const rootList = Array.isArray(roots)
      ? roots
      : (typeof roots === "function" ? roots() : [base]);
    const allowedRoots = (rootList || []).map((r) => String(r || "")).filter(Boolean);
    const summary = await runClaims(claimList, {
      roots: allowedRoots.length ? allowedRoots : [base],
      cwd: base,
      ...(typeof run === "function" ? { run } : {}),
      maxClaims,
    });
    return {
      text: formatClaimReport(summary),
      isError: !summary.ok,
      details: summary,
    };
  };
}

/** 一次性调用（server 执行器表里用这个，比较省事）。 */
export function executeVerifyCheck(args = {}, opts = {}) {
  return createVerifyCheckExecutor(opts)(args);
}
