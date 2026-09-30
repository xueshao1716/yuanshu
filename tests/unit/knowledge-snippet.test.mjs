import test from 'node:test';import assert from 'node:assert/strict';
import {fitKnowledgeSnippet} from '../../engine/knowledge-snippet.mjs';
test('snippets preserve Unicode codepoints and absolute UTF16 positions under byte budgets',()=>{
 const text='😀前文'.repeat(300)+'目标规则'+'🚀后文'.repeat(300);
 const piece=fitKnowledgeSnippet({text,focus:'目标规则',fits:s=>Buffer.byteLength(JSON.stringify(s))<=100});
 assert.ok(piece);assert.ok(piece.text.includes('目标规则'));assert.equal(piece.text,text.slice(piece.offset,piece.offset+piece.length));
 assert.equal(piece.text.isWellFormed(),true);assert.ok(Buffer.byteLength(JSON.stringify(piece))<=100);
});
test('a long user query can still select a useful short exact slice when whole query cannot fit',()=>{
 const text='目标规则'.repeat(100);
 const piece=fitKnowledgeSnippet({text,focus:text,fits:s=>Buffer.byteLength(JSON.stringify(s))<=100});
 assert.ok(piece);assert.ok(piece.text.includes('目标'));assert.ok(Buffer.byteLength(JSON.stringify(piece))<=100);
});
