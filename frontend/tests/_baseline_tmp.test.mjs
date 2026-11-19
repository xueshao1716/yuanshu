import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { generateTheme, SEEDS } from '../src/theme/generate.mjs'

function fixture() {
  const saved = new Map([['pi_theme', 'mist'], ['pi_theme_migrated_20260910', '1']])
  const exports = {}
  const script = ts.transpileModule(readFileSync(new URL('../../.tmp-baseline/apply.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) }
  const document = { documentElement: { dataset: {}, style: { setProperty() {} } } }
  vm.runInNewContext(script, { exports, localStorage, document, window: { dispatchEvent() {} }, CustomEvent: class {}, require: name => name.includes('generate') ? { generateTheme, SEEDS } : name.includes('wallpaper') ? { persistWallpaper() {} } : { ThemeApi: { save: () => Promise.resolve() } } })
  return { exports, saved }
}
test('a remote explicit wood choice wins over a locally migrated default without saving remotely', () => {
  const { exports, saved } = fixture()
  exports.restoreThemePreferences({ theme: 'wood', accent: '#0B8A54' })
  assert.equal(saved.get('pi_theme'), 'wood')
  assert.equal(exports.currentTheme().theme, 'wood')
  assert.equal(saved.get('pi_theme'), 'wood')
})
test('legacy local wood is an explicit choice, not a trigger for a silent theme rewrite', () => {
  const { exports, saved } = fixture()
  saved.set('pi_theme', 'wood')
  saved.delete('pi_theme_migrated_20260910')
  assert.equal(exports.currentTheme().theme, 'wood')
})
