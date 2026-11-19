// engine/doc-extract.mjs —— read 工具读 Word / Excel / PPT / PDF（2026-11-19）
//
// 以前 read 只认纯文本：.docx/.xlsx/.pptx 不在二进制名单里，被当 utf8 硬读成乱码；
// PDF 只回一句"请用 pdftotext"。模型只好每次现写 python 脚本绕路。
// 这里统一转成可读文本（标题/段落/Markdown 表格），只读、不改权限。
// 解析库与安装包一致：python-docx / openpyxl / xlrd / python-pptx，PDF 用 PyMuPDF（没有再退 pdftotext）。
import { execFile } from "node:child_process";
import path from "node:path";
import { resolvePython } from "./wechat/voice.mjs";

export const DOC_EXTS = new Set([".docx", ".xlsx", ".xlsm", ".xls", ".pptx", ".pdf"]);
const MAX_ROWS = 200;        // 每个工作表最多输出的行数
const MAX_CHARS = 50000;     // 与 read 纯文本上限一致

const SCRIPT = String.raw`
import sys, io, os
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
p, ext, max_rows = sys.argv[1], sys.argv[2], int(sys.argv[3])
cell = lambda v: "" if v is None else str(v).replace("\n", " ").replace("|", "\\|").strip()
def table(rows):
    rows = [r for r in rows if any(c for c in r)]
    if not rows: return []
    w = max(len(r) for r in rows)
    rows = [r + [""] * (w - len(r)) for r in rows]
    return ["| " + " | ".join(rows[0]) + " |", "|" + "---|" * w] + ["| " + " | ".join(r) + " |" for r in rows[1:]]
out = []
if ext == ".docx":
    import docx
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    d = docx.Document(p)
    for el in d.element.body.iterchildren():
        tag = el.tag.rsplit("}", 1)[-1]
        if tag == "p":
            para = Paragraph(el, d)
            t = para.text.strip()
            if not t: continue
            st = (para.style.name or "").lower() if para.style is not None else ""
            lv = next((n for n in (1, 2, 3, 4) if ("heading %d" % n) in st or ("标题 %d" % n) in st), 0)
            out.append(("#" * lv + " " + t) if lv else t)
        elif tag == "tbl":
            out += [""] + table([[cell(c.text) for c in r.cells] for r in Table(el, d).rows]) + [""]
elif ext in (".xlsx", ".xlsm"):
    import openpyxl
    wb = openpyxl.load_workbook(p, read_only=True, data_only=True)
    for ws in wb.worksheets:
        rows, total = [], 0
        for r in ws.iter_rows(values_only=True):
            vals = [cell(v) for v in r]
            if not any(vals): continue
            total += 1
            if len(rows) < max_rows: rows.append(vals)
        out.append("## 工作表：%s（%d 行有内容）" % (ws.title, total))
        out += table(rows)
        if total > len(rows): out.append("（只显示前 %d 行，共 %d 行；要看其余部分请用 bash + openpyxl 按需读取）" % (len(rows), total))
        out.append("")
elif ext == ".xls":
    import xlrd
    wb = xlrd.open_workbook(p)
    for ws in wb.sheets():
        rows = [[cell(v) for v in ws.row_values(i)] for i in range(min(ws.nrows, max_rows))]
        out.append("## 工作表：%s（%d 行）" % (ws.name, ws.nrows))
        out += table(rows)
        if ws.nrows > max_rows: out.append("（只显示前 %d 行，共 %d 行）" % (max_rows, ws.nrows))
        out.append("")
elif ext == ".pptx":
    from pptx import Presentation
    for i, s in enumerate(Presentation(p).slides, 1):
        out.append("## 第 %d 页" % i)
        for sh in s.shapes:
            if getattr(sh, "has_table", False) and sh.has_table:
                out += table([[cell(c.text) for c in r.cells] for r in sh.table.rows])
            elif getattr(sh, "has_text_frame", False) and sh.has_text_frame:
                t = sh.text_frame.text.strip()
                if t: out.append(t)
        if s.has_notes_slide:
            n = s.notes_slide.notes_text_frame.text.strip()
            if n: out.append("（备注）" + n)
        out.append("")
elif ext == ".pdf":
    import fitz
    doc = fitz.open(p)
    for i, pg in enumerate(doc, 1):
        t = pg.get_text().strip()
        if t: out += ["## 第 %d 页" % i, t, ""]
    if not out: out.append("（PDF 里没有可提取的文字，可能是扫描件/图片）")
print("\n".join(out))
`;

function runPy(python, file, ext, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(python, ["-c", SCRIPT, file, ext, String(MAX_ROWS)], {
      timeout: timeoutMs, windowsHide: true, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    }, (err, stdout, stderr) => err ? reject(new Error(String(stderr || err.message).trim().split("\n").pop())) : resolve(stdout));
  });
}

function runPdftotext(file, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile("pdftotext", ["-enc", "UTF-8", "-layout", file, "-"], { timeout: timeoutMs, windowsHide: true, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => err ? reject(err) : resolve(stdout));
  });
}

/**
 * 把文档转成文本。失败不抛，返回 { ok:false, error }，由 read 给出可操作的提示。
 * @returns {Promise<{ok:boolean, text?:string, truncated?:boolean, error?:string}>}
 */
export async function extractDocText(file, { python = resolvePython(), timeoutMs = 60000, maxChars = MAX_CHARS } = {}) {
  const ext = path.extname(file).toLowerCase();
  if (!DOC_EXTS.has(ext)) return { ok: false, error: `不支持的格式 ${ext}` };
  let text;
  try {
    text = await runPy(python, file, ext, timeoutMs);
  } catch (e) {
    if (ext === ".pdf") {
      try { text = await runPdftotext(file, timeoutMs) } catch {}
    }
    if (text === undefined) return { ok: false, error: String(e?.message || e).slice(0, 300) };
  }
  text = String(text || "").replace(/\r\n/g, "\n").trim();
  const truncated = text.length > maxChars;
  return { ok: true, text: truncated ? text.slice(0, maxChars) : text, truncated };
}
