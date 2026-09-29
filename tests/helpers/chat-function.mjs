import fs from 'node:fs';
import vm from 'node:vm';
import ts from '../../frontend/node_modules/typescript/lib/typescript.js';

export function chatFunction(name, scope) {
  const source = ts.createSourceFile('ChatArea.tsx', fs.readFileSync(new URL('../../frontend/src/components/ChatArea.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) initializer = node.initializer;
    if (!initializer) ts.forEachChild(node, visit);
  };
  visit(source);
  if (!initializer) throw new Error(`Missing ${name}`);
  const code = ts.transpileModule(`const extracted = ${initializer.getText(source)}; extracted;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return vm.runInNewContext(code, { console, setTimeout, ...scope });
}
export function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

export function chatEffect(marker, scope) {
  const source = ts.createSourceFile('ChatArea.tsx', fs.readFileSync(new URL('../../frontend/src/components/ChatArea.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[0]?.getText(source).includes(marker)) callback = node.arguments[0];
    if (!callback) ts.forEachChild(node, visit);
  };
  visit(source);
  if (!callback) throw new Error(`Missing effect ${marker}`);
  const code = ts.transpileModule(`const effect = ${callback.getText(source)}; effect;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return vm.runInNewContext(code, { console, setTimeout, ...scope });
}
