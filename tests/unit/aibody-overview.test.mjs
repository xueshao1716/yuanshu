import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMiscApi } from '../../engine/misc-api.mjs'

test('aibody overview maps the three layers to available project evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piweb-aibody-'))
  let response
  try {
    fs.mkdirSync(path.join(root, 'engine'), { recursive: true })
    fs.writeFileSync(path.join(root, 'engine', 'gene.mjs'), 'export {}')
    fs.writeFileSync(path.join(root, 'engine', 'memory', 'gardener.mjs'), 'export {}')
    const api = createMiscApi({
      json: (_res, status, body) => { response = { status, body } },
      readJsonFile: () => ({}), writeJsonFile: () => true,
      getAgentDir: () => root, authPath: '', modelsPath: '', cwd: root,
      openSession: async () => null, ensureAgent: async () => {}, getDefaultModel: () => null,
      refreshModelList: async () => {}, scanSessionFiles: () => [], extractText: () => '', parseSessionFile: () => ({}),
      scanExclude: /node_modules/i, projectRoot: root,
    })
    await api.handleAIBody({})
    assert.equal(response.status, 200)
    assert.deepEqual(response.body.layers.map(layer => layer.id), ['host', 'organism', 'expression'])
    const organism = response.body.layers.find(layer => layer.id === 'organism')
    assert.equal(organism.modules.some(module => module.path === 'engine/gene.mjs' && module.available), true)
    assert.equal(Array.isArray(response.body.theory), true)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
