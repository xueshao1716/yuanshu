// 「@文件引用」要不要内联进对话？（2026-09-16，来自外部机器安装检查的第 4 个 bug）
//
// 问题：把 xlsx/docx/pdf/zip/图片 这类二进制文件的字节当文本拼进 prompt，
// 结果是一堆乱码——既浪费 token，又污染对话，模型还会照着乱码瞎猜内容。
//
// 做法：① 看扩展名；② 嗅探内容里控制字符的比例（有些文件扩展名看不出来，
// 比如被改名成 .txt 的二进制）。命中任一条件就不内联，改成一条**可执行**的提示：
// 按路径用解析工具读（POST /api/parse-file 支持 docx/xlsx/pptx）。
//
// 注意：.svg / .csv / .json / .md / .txt 这些是文本，绝不能误判——误判会让模型看不到内容，
// 比乱码更糟（它会以为文件是空的）。
const BINARY_EXT = /^(xlsx|xlsm|xlsb|xls|doc|docx|dot|dotx|ppt|pptx|pps|ppsx|pdf|zip|rar|7z|gz|tgz|tar|bz2|xz|exe|dll|msi|bin|so|dylib|class|jar|apk|ipa|dmg|iso|png|jpg|jpeg|gif|webp|bmp|ico|tif|tiff|heic|mp3|mp4|m4a|wav|flac|ogg|opus|webm|avi|mkv|mov|wmv|db|sqlite|sqlite3|woff|woff2|ttf|otf|eot)$/;

export function referenceExt(path) {
  const p = String(path || "").trim().toLowerCase();
  if (!p || p.endsWith(".") || p.endsWith("/") || p.endsWith("\\")) return "";
  const base = p.split(/[\\/]/).pop() || "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1) : "";
}

// 控制字符占比嗅探：NUL / 替换符 / 除 \t\n\r 之外的 C0 控制符都算"不像文本"。
export function looksBinaryContent(content, { maxSample = 2000, threshold = 0.05 } = {}) {
  const s = typeof content === "string" ? content : "";
  if (!s) return false;
  const head = s.slice(0, maxSample);
  let bad = 0;
  for (const ch of head) {
    const c = ch.codePointAt(0);
    if (c === 0 || c === 0xfffd || c < 9 || (c > 13 && c < 32)) bad++;
  }
  return bad / head.length > threshold;
}

export function isBinaryReference(file) {
  if (!file) return false;
  if (BINARY_EXT.test(referenceExt(file.path))) return true;
  return looksBinaryContent(file.content);
}

// 不内联之后要说清楚"接下来该怎么办"，否则模型只能瞎猜——比乱码更隐蔽的错误。
export function binaryReferenceNote(path) {
  return `参考文件 ${path}：（二进制文件，原始内容不适合内联到对话，已跳过。请按此路径用文件解析工具读取——POST /api/parse-file 支持 docx/xlsx/pptx；其它格式按二进制处理，不要凭空猜测其内容。）`;
}
