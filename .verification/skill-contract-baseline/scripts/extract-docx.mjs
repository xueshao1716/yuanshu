// 把 .docx 抽成可读文本（docx 是 zip + XML，read 工具读不了二进制）。
// 用法：node scripts/extract-docx.mjs <in.docx> <out.txt>
// 放在仓库根 scripts/：skills/ 下每个子目录都会被当成一个技能，不放工具脚本。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export function extractDocx(docxPath) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-'))
  try {
    const zip = path.join(tmp, 'in.zip')
    fs.copyFileSync(docxPath, zip)
    // PowerShell 的 Expand-Archive 认得 .zip；解出来读 word/document.xml
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${path.join(tmp, 'x')}' -Force`], { stdio: 'ignore' })
    const xml = fs.readFileSync(path.join(tmp, 'x', 'word', 'document.xml'), 'utf8')
    return xml
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:br\b[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
      .replace(/\r/g, '')
      .split('\n').map(l => l.replace(/[ \t]+$/g, '')).join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  }
}

if (process.argv[1] && process.argv[2] && process.argv[3]) {
  const text = extractDocx(process.argv[2])
  fs.writeFileSync(process.argv[3], text + '\n', 'utf8')
  const lines = text.split('\n')
  console.log(`抽出 ${lines.length} 行 / ${text.replace(/\s/g, '').length} 非空白字符 → ${process.argv[3]}`)
}
