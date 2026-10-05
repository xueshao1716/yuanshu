import fs from 'node:fs'
const dir = 'frontend/dist/assets'
const marks = ['无法由本次放权修复', '请先按上方清单核对', 'stubborn', 'policy.enabled']
const found = {}
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.js')) continue
  const s = fs.readFileSync(`${dir}/${f}`, 'utf8')
  for (const m of marks) if (s.includes(m)) (found[m] ||= []).push(f)
}
for (const m of marks) console.log(m, '=>', (found[m] || []).slice(0, 3).join(',') || '未命中')
