import test from 'node:test'
import assert from 'node:assert/strict'

test('save picker is requested immediately and native Android bridge remains authoritative', async () => {
  const { requestBrowserSave } = await import('../../frontend/src/lib/browser-save.ts')
  let requested = 0
  const host = { showSaveFilePicker: (options) => { requested++; assert.equal(options.suggestedName, '图.png'); return Promise.resolve({}) } }
  const pending = requestBrowserSave('图.png', host)
  assert.equal(requested, 1)
  await pending
  assert.equal(await requestBrowserSave('图.png', { ...host, YuanshuDownloads: {} }), null)
  assert.equal(requested, 1)
})

test('file saving confirms only after the writable closes and aborts failed writes', async () => {
  const { writeBrowserSave } = await import('../../frontend/src/lib/browser-save.ts')
  const calls = []
  const bytes = new Blob(['image bytes'])
  const handle = { createWritable: async () => ({ write: async b => calls.push(await b.text()), close: async () => calls.push('close'), abort: async () => calls.push('abort') }) }
  await writeBrowserSave(handle, bytes)
  assert.deepEqual(calls, ['image bytes', 'close'])
  await assert.rejects(writeBrowserSave({ createWritable: async () => ({ write: async () => { throw new Error('disk full') }, abort: async () => calls.push('abort') }) }, bytes), /disk full/)
  assert.equal(calls.at(-1), 'abort')
})

test('cancelled picker never falls through to a silent browser download', async () => {
  const { requestBrowserSave } = await import('../../frontend/src/lib/browser-save.ts')
  await assert.rejects(requestBrowserSave('图.png', { showSaveFilePicker: async () => { throw new DOMException('cancel', 'AbortError') } }), /已取消保存/)
})
