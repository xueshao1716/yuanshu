// read 直接读 Word / Excel / PPT / PDF（2026-11-19）
// 样本用 python 现场生成；本机没有对应库时跳过（CI 不一定装）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { extractDocText, DOC_EXTS } from "../../engine/doc-extract.mjs";
import { resolvePython } from "../../engine/wechat/voice.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docx-"));
const py = resolvePython();
let ready = false;
try {
  execFileSync(py, ["-c", String.raw`
import sys, docx, openpyxl, fitz
from pptx import Presentation
d = sys.argv[1]
doc = docx.Document(); doc.add_heading("季度报告", 1); doc.add_paragraph("营收增长 12%")
t = doc.add_table(rows=2, cols=2); t.cell(0,0).text="地区"; t.cell(0,1).text="销售额"; t.cell(1,0).text="华东"; t.cell(1,1).text="300"
doc.add_paragraph("表格之后的结论"); doc.save(d + "/a.docx")
wb = openpyxl.Workbook(); ws = wb.active; ws.title = "明细"; ws.append(["产品", "数量"]); ws.append(["苹果", 3]); ws["C2"] = "=B2*2"
for i in range(250): ws.append(["行%d" % i, i])
wb.save(d + "/b.xlsx")
pr = Presentation(); s = pr.slides.add_slide(pr.slide_layouts[1]); s.shapes.title.text = "路线图"; s.placeholders[1].text = "第一阶段上线"; pr.save(d + "/c.pptx")
pdf = fitz.open(); pg = pdf.new_page(); pg.insert_text((72, 72), "Hello PDF page"); pdf.save(d + "/d.pdf")
`, dir], { windowsHide: true, timeout: 60000 });
  ready = true;
} catch {}
const skip = ready ? false : "本机缺 python 文档库";

test("支持的扩展名", () => {
  for (const e of [".docx", ".xlsx", ".xls", ".pptx", ".pdf"]) assert.ok(DOC_EXTS.has(e));
  assert.ok(!DOC_EXTS.has(".doc"));
});

test("Word：标题、正文、表格按原顺序输出", { skip }, async () => {
  const r = await extractDocText(path.join(dir, "a.docx"));
  assert.equal(r.ok, true, r.error);
  assert.match(r.text, /# 季度报告/);
  assert.match(r.text, /\| 地区 \| 销售额 \|/);
  assert.ok(r.text.indexOf("华东") < r.text.indexOf("表格之后的结论"), "表格应在后续段落之前");
});

test("Excel：按工作表输出表格，超过 200 行截断并说明总数", { skip }, async () => {
  const r = await extractDocText(path.join(dir, "b.xlsx"));
  assert.equal(r.ok, true, r.error);
  assert.match(r.text, /工作表：明细（252 行有内容）/);
  assert.match(r.text, /\| 苹果 \| 3 \|/);
  assert.match(r.text, /只显示前 200 行，共 252 行/);
});

test("PPT 与 PDF：按页输出文字", { skip }, async () => {
  const p = await extractDocText(path.join(dir, "c.pptx"));
  assert.match(p.text, /第 1 页[\s\S]*路线图[\s\S]*第一阶段上线/);
  const d = await extractDocText(path.join(dir, "d.pdf"));
  assert.match(d.text, /Hello PDF page/);
});

test("坏文件不抛异常，返回可读的错误", { skip }, async () => {
  const bad = path.join(dir, "bad.docx");
  fs.writeFileSync(bad, "not a zip");
  const r = await extractDocText(bad);
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test("read 工具直接返回文档文本；.doc 给出另存提示", { skip }, async () => {
  const { createUnifiedToolExecutor } = await import("../../engine/tools/unified-tools.mjs");
  const exec = createUnifiedToolExecutor({ cwd: () => dir, safePath: (p) => path.resolve(dir, String(p || "")) });
  const r = await exec("read", { path: "a.docx" });
  assert.equal(r.isError, false);
  assert.match(r.text, /^\[文档\] a\.docx/);
  assert.match(r.text, /营收增长 12%/);
  fs.writeFileSync(path.join(dir, "old.doc"), "x");
  assert.match((await exec("read", { path: "old.doc" })).text, /另存为 \.docx/);
});
