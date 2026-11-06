import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from '../../frontend/node_modules/typescript/lib/typescript.js';
import * as workspaceApi from '../../engine/workspace-api.mjs';

test('server workspace imports all exist without starting production services', () => {
  const source = fs.readFileSync(new URL('../../server.mjs', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('server.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = ast.statements.find(statement => ts.isImportDeclaration(statement)
    && statement.moduleSpecifier.text === './engine/workspace-api.mjs');
  assert.ok(declaration, 'server must retain the workspace API integration');
  const bindings = declaration.importClause?.namedBindings;
  assert.ok(bindings && ts.isNamedImports(bindings));
  const missing = bindings.elements.map(element => (element.propertyName || element.name).text)
    .filter(name => !Object.hasOwn(workspaceApi, name));
  assert.deepEqual(missing, [], 'every workspace API named import must link before server startup');
});
