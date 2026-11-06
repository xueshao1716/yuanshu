import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

test('Board consumes RunApi overview and renders shared work explanations', () => {
  const src = read('frontend/src/pages/Board.tsx')
  assert.match(src, /RunApi\.overview\(\)/)
  assert.ok(src.includes('<WorkExplanationList'))
  assert.match(src, /HealthBadge/)
})

test('shared run components expose accessible phase and health labels', () => {
  assert.match(read('frontend/src/components/run/RunTimeline.tsx'), /aria-label={`运行阶段：\$\{phase\}`}/)
  assert.match(read('frontend/src/components/run/HealthBadge.tsx'), /状态正常/)
})
