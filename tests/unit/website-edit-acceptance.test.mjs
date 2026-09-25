import test from 'node:test';
import assert from 'node:assert/strict';
import {assertOutsideSelectionUnchanged} from '../../scripts/website-edit-acceptance.mjs';

const before={html:'<main><section id="target"><p>Hello<br />world</p><hr /></section><aside>Keep me</aside></main>',css:'main{color:black}'};
const edited={...before,html:before.html.replace('id="target"','id="target" style="border-top:4px solid #d35400"')};
test('accepts a selected edit with sanitized void elements',()=>{
  assert.doesNotThrow(()=>assertOutsideSelectionUnchanged(before,edited,'target'));
});
for(const [name,after] of [
  ['sibling text',{...edited,html:edited.html.replace('Keep me','Changed')}],
  ['ancestor attributes',{...edited,html:edited.html.replace('<main>','<main class="changed">')}],
  ['selection position',{...edited,html:'<main><aside>Keep me</aside><section id="target"><br /></section></main>'}],
  ['global CSS',{...edited,css:'main{color:red}'}],
  ['missing selection',{...edited,html:'<main><aside>Keep me</aside></main>'}],
  ['duplicate selection',{...edited,html:edited.html.replace('</main>','<section id="target">Duplicate</section></main>')}],
])test(`rejects changes to ${name}`,()=>{
  assert.throws(()=>assertOutsideSelectionUnchanged(before,after,'target'));
});
