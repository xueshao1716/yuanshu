// ===== path-key.mjs —— 路径归一化键（2026-11-13）=====
//
// pi 1.5 修过的坑：`c:\Users\me` 与 `C:\Users\me` 被当成两个目录，
// 结果是技能重复加载、`/resume` 看不到会话。
// 元枢里凡是拿路径当 Map 键 / 去重判断 / 相等比较的地方，都该先过 pathKey()。
//
// 用法边界：这个返回值只用来**比较和做键**，不要拿去做 I/O——
// 归一后的大小写/斜杠在大小写敏感的文件系统上不一定能打开。
//
// 规则：
//   · Windows：整条路径转小写（NTFS 默认大小写不敏感）+ 反斜杠转正斜杠 + 去尾斜杠；
//   · 其它平台：原样返回（POSIX 路径大小写敏感，动了就是新 bug）。
export function pathKey(p, platform = process.platform) {
  if (p === null || p === undefined) return "";
  const raw = String(p);
  if (!raw) return "";
  if (platform !== "win32") return raw;
  let s = raw.replace(/\\/g, "/").toLowerCase();
  // 只去尾斜杠，"c:/" 这种盘根去完是 "c:"，和 "c:" 写法保持同一个键
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}
