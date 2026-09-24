import test from 'node:test'
import assert from 'node:assert/strict'
import { copyText } from '../../frontend/src/lib/clipboard.ts'

for (const succeeds of [true, false]) test(`fallback copy restores address focus and selection on ${succeeds ? 'success' : 'failure'}`, async t => {
  let focused = false, selected = null, removed = false
  const field = { selectionStart: 2, selectionEnd: 9, selectionDirection: 'backward',
    focus: () => { focused = true }, setSelectionRange: (...args) => { selected = args } }
  const textarea = { style: {}, setAttribute() {}, select() {}, remove() { removed = true } }
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async () => { throw Error('denied') } } } })
  t.after(() => { if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator })
  const old = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: field,
    createElement: () => textarea, body: { appendChild() {} }, getSelection: () => null,
    execCommand: () => { if (!succeeds) throw Error('denied'); return true } } })
  t.after(() => { if (old) Object.defineProperty(globalThis, 'document', old); else delete globalThis.document })
  assert.equal(await copyText('https://example.test'), succeeds)
  assert.equal(removed, true)
  assert.equal(focused, true)
  assert.deepEqual(selected, [2, 9, 'backward'])
})
