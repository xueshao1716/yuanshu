import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeTypography, typographyVars, TYPO_DEFAULTS } from '../../frontend/src/theme/typography.mjs'

test('typography: clamps and snaps values, falls back to defaults', () => {
  assert.deepEqual(normalizeTypography(null), TYPO_DEFAULTS)
  const t = normalizeTypography({ scale: 9, chatSize: 15.4, letterSpacing: -1, lineHeight: 'x' })
  assert.equal(t.scale, 1.3)
  assert.equal(t.chatSize, 15)
  assert.equal(t.letterSpacing, 0)
  assert.equal(t.lineHeight, TYPO_DEFAULTS.lineHeight)
})

test('typography: vars feed chat text and zoom', () => {
  const v = typographyVars({ scale: 1.1, chatSize: 16, letterSpacing: 0.05, lineHeight: 1.9 })
  assert.deepEqual(v, { '--pi-ui-zoom': '1.1', '--pi-chat-size': '16px', '--pi-chat-tracking': '0.05em', '--pi-chat-leading': '1.9' })
  const css = readFileSync(new URL('../../frontend/src/premium.css', import.meta.url), 'utf8')
  assert.match(css, /font-size: var\(--pi-chat-size, 14px\)/)
  assert.match(css, /\.msg-user-text \{/)
  const page = readFileSync(new URL('../../frontend/src/pages/Themes.tsx', import.meta.url), 'utf8')
  assert.match(page, /<TypographyPanel \/>/)
})
