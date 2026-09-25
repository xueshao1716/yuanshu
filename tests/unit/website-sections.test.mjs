import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePlan,validateSection,assembleSections} from '../../engine/website-sections.mjs';
const plan={direction:'内容驱动',css:'body{margin:0}',sections:[{title:'开篇',brief:'标题'}]};
test('section CSS scopes pseudo-elements and namespaces animations',()=>{
  const section=validateSection({html:'<section id="site-section-1"><h1>标题</h1></section>',css:'h1::before{content:"你好"}@media(min-width:400px){h1{color:red}}@keyframes fade{from{opacity:0}to{opacity:1}}h1{animation:fade 1s}'},1,plan,[]);
  assert.ok(section.css.includes(':is(h1)::before'));
  assert.ok(!section.css.includes(':is(h1::before)'));
  assert.match(section.css,/animation:site-section-1-fade/);
  assert.match(section.css,/@keyframes site-section-1-fade/);
});
test('invalid plans, duplicate IDs, wrong roots and CSS nesting are rejected',()=>{
  assert.throws(()=>validatePlan({...plan,sections:[]}),/计划/);
  assert.throws(()=>validateSection({html:'<section id="wrong">x</section>',css:''},1,plan,[]),/根元素/);
  assert.throws(()=>validateSection({html:'<section id="site-section-1">x</section>',css:'.card{h1{color:red}}'},1,plan,[]),/嵌套/);
  assert.throws(()=>assembleSections(plan,[{html:'<div id="same">a</div>',css:''},{html:'<div id="same">b</div>',css:''}]),/重复/);
});
