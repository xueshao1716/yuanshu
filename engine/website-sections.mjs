import postcss from 'postcss';
import {parseHTML} from 'linkedom';
import {designError} from './ui-design-document.mjs';
import {validateWebsite} from './website-document.mjs';

export const websiteRules='你是专业网站设计师。只返回 JSON，不要 Markdown、说明或工具调用。只用语义 HTML 与 CSS，不用 JS、SVG、iframe、表单、外部 CSS、@import。不含 html/head/body/style 标签。图片只用 HTTPS，不编造本地路径。保留中文内容、移动端适配、足够对比度、prefers-reduced-motion。设计由主题、内容和用户需求决定，不套用固定版式。';

export function validatePlan(input) {
  if(typeof input?.direction!=='string'||!input.direction.trim()||input.direction.length>5000||!Array.isArray(input.sections)||!input.sections.length||input.sections.length>8) throw designError('设计计划需有明确方向和 1–8 个区块');
  const sections=input.sections.map(s=>{
    if(typeof s?.title!=='string'||!s.title.trim()||s.title.length>100||typeof s.brief!=='string'||!s.brief.trim()||s.brief.length>2000)throw designError('区块计划需包含标题和内容说明');
    return {title:s.title,brief:s.brief};
  });
  const {css}=validateWebsite({html:'<main></main>',css:input.css});
  if(css.length>30000)throw designError('全局样式过长，请将具体样式放入区块');
  return {direction:input.direction,css,sections};
}

export function assembleSections(plan,sections) {
  return validateWebsite({html:sections.map(s=>s.html).join('\n'),css:[plan.css,...sections.map(s=>s.css)].join('\n')});
}

// Pseudo-elements must stay outside :is(); reject ambiguous selectors for repair.
function splitPseudoElement(selector) {
  let quote='',square=0,round=0;
  for(let i=0;i<selector.length;i++) {
    const c=selector[i];
    if(quote){if(c===quote)quote='';continue;}
    if(c==='"'||c==="'"){quote=c;continue;}
    if(c==='[')square++;else if(c===']')square--;
    if(square)continue;
    if(c==='(')round++;else if(c===')')round--;
    const pseudo=selector.slice(i).match(/^(::[\w-]+|:(?:before|after|first-line|first-letter))(?![\w-])/i);
    if(c===':'&&pseudo) {
      if(round||selector.slice(i+ pseudo[0].length).trim())throw designError('伪元素需放在选择器末尾，请使用平铺样式');
      const base=selector.slice(0,i);
      return [(base.trim()?base:'*')+(/[\s>+~]$/.test(base)?'*':''),pseudo[0]];
    }
  }
  return [selector,''];
}

export function validateSection(answer,index,plan,previous) {
  const doc=validateWebsite(answer),id=`site-section-${index}`;
  const {document}=parseHTML(`<html><body>${doc.html}</body></html>`);
  if(document.body.children.length!==1||document.body.firstElementChild.id!==id||[...document.body.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()))throw designError(`区块必须只有一个根元素，id 为 ${id}`);
  const tree=postcss.parse(doc.css),keyframes=new Map();
  tree.walkAtRules(rule=>{if(/keyframes$/i.test(rule.name)){const name=rule.params.trim();keyframes.set(name,`${id}-${name}`);rule.params=`${id}-${name}`;}});
  tree.walkRules(rule=>{
    for(let parent=rule.parent;parent;parent=parent.parent)if(parent.type==='rule')throw designError('不支持嵌套 CSS，请展开为平铺选择器');
    if(rule.parent.type==='atrule'&&/keyframes$/i.test(rule.parent.name))return;
    // Scope both the root and its descendants; never leak a generated rule to a sibling.
    rule.selectors=rule.selectors.flatMap(selector=>{
      const scoped=selector.replace(/(^|[\s>+~,(])(html|body|:root)(?=$|[\s>+~.#:[,)])/g,`$1#${id}`);
      const [base,pseudo]=splitPseudoElement(scoped);
      return [`:where(#${id}):is(${base})${pseudo}`,`:where(#${id}) :is(${base})${pseudo}`];
    });
  });
  tree.walkDecls(/^animation(?:-name)?$/,decl=>{
    decl.value=decl.value.replace(/[a-zA-Z_][\w-]*/g,word=>keyframes.get(word)||word);
  });
  const section={html:doc.html,css:tree.toString()};
  assembleSections(plan,[...previous,section]);
  return section;
}
