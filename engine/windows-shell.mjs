// engine/windows-shell.mjs —— Windows 上的两个老坑，尽量在**代码里**治掉，而不是靠人记得（2026-09-18）
//
// 用户的原话："经常踩 gbk 编码，以及 cmd 引号转义的坑怎么治"。
// 这两件事在真机上反复咬人：
//   ① 编码：cmd 的默认代码页是 936(GBK)，于是
//      · 命令**输出**里带中文时，按 utf8 解会得到一串 U+FFFD（`[鍏冩灑]` 这种乱码）；
//      · `echo 中文 > f.txt` 写出来的文件是 GBK 字节，回头用 read（utf8）看就是乱码；
//      · PowerShell 里 `Get-Content/Set-Content` 默认按 ANSI 走，整文件读写会把 UTF-8 中文毁掉。
//   ② 引号：`cmd /c` 这一层的转义规则和 libuv 的转义规则**不一样**——`node -e "…"`、
//      含空格的路径（`C:\Program Files\…`）、嵌套引号，经常一进去就
//      `'C:\Program' 不是内部或外部命令` 或者干脆静默截断。
//
// 治法是三层，缺一层都还会犯：
//   · **运行时层**（这个模块）：进 cmd 前先 `chcp 65001`，让输出与重定向走 UTF-8；
//     解码时 UTF-8 解不出再用 GBK 兜底（两边都不认才原样保留）。
//   · **工具层**（unified-tools.mjs）：内联代码（`node -e`/`python -c`）改写成临时脚本文件再
//     execFile 解释器执行——**绕开 cmd 的引号解析**，这一段早已在做，这里是把它讲清楚。
//   · **纪律层**（skills/windows-shell-playbook）：写文件用 write 工具、不要 Get-Content/Set-Content
//     处理 UTF-8、路径带空格一定要引号、脚本落文件再跑。

/** 进 cmd 前的前缀：把代码页切到 UTF-8，并吞掉 chcp 自己那行输出。 */
export const UTF8_PREFIX = "chcp 65001>nul & ";

/**
 * 给一条 Windows cmd 命令套上 UTF-8 代码页。
 * 只认 cmd（bash 不需要，PowerShell 另有 `-Encoding utf8` 一套规矩）；已经是 UTF-8 前缀就不重复加。
 */
export function withUtf8CodePage(cmd, { platform = process.platform, shell = null } = {}) {
  const s = String(cmd ?? "");
  if (platform !== "win32" || shell || !s.trim()) return s;
  if (/^\s*chcp\s+65001/i.test(s)) return s;
  return UTF8_PREFIX + s;
}

/**
 * 解 Windows 命令输出：UTF-8 优先，出现替换字符再用 GBK 兜底。
 * Node 自带 TextDecoder('gbk')（full-icu），所以不需要额外依赖。
 * 两种都不认时返回 utf8 的结果——**不要**为了"看起来干净"把内容丢了。
 */
export function decodeWindowsOutput(buf, { platform = process.platform } = {}) {
  if (buf == null) return "";
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), "utf8");
  if (!bytes.length) return "";
  const utf8 = bytes.toString("utf8");
  if (platform !== "win32" || !utf8.includes("\uFFFD")) return utf8;
  try {
    const gbk = new TextDecoder("gbk").decode(bytes);
    // GBK 解出来还带替换字符，说明两边都不认——保留 utf8 结果（有损但至少是同一次解码）
    return gbk.includes("\uFFFD") ? utf8 : gbk;
  } catch {
    return utf8;
  }
}

/**
 * 输出里是否**确定**像乱码（给调用方决定要不要提示重跑）。
 *
 * 只认两个铁证：替换字符 U+FFFD，以及私用区（U+E000–U+F8FF）。
 * 刻意**不**去猜"GBK 被当 UTF-8 读"的那种错码汉字（`鍏冩灑` 之类）——它们本身就是合法汉字，
 * 猜错就会给正常输出贴标签。真正的治法在上面：切代码页 + GBK 兜底解码，而不是靠事后识别。
 */
export function looksMojibake(text) {
  return /\uFFFD|[\uE000-\uF8FF]/.test(String(text || ""));
}

/**
 * 这条命令里有没有"过 cmd 大概率会被拆坏"的东西（内联代码 / 含空格的未引号路径）。
 * 只用来**提醒**：真正的修法是改写或落文件，不是让模型继续试。
 */
export function riskyForCmdShell(cmd) {
  const s = String(cmd ?? "");
  if (!s.trim()) return null;
  if (/\b(?:node|python|python3|deno|pwsh|powershell)\b[^|&]*\s-(?:e|c)\s/i.test(s)) {
    return "内联代码（node -e / python -c）过 cmd 会被引号规则拆坏——落成脚本文件再跑（bash 工具会自动改写 node -e）";
  }
  if (/[A-Za-z]:\\[^"'\s]*\s[^"']*\.(?:exe|cmd|bat|ps1|js|mjs)\b/.test(s) && !/"[^"]*\s[^"]*"/.test(s)) {
    return "路径里有空格却没用引号包住——cmd 会把它拆成两段（`'C:\\Program' 不是内部或外部命令`）";
  }
  return null;
}
