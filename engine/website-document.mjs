import sanitize from 'sanitize-html';
import postcss from 'postcss';
import {parseHTML} from 'linkedom';
import {designError} from './ui-design-document.mjs';

export const escapeHtml = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeUrl = value => /^(https:\/\/[^\s]+|#[\w-]+|mailto:[^\s]+|tel:[+\d -]+|data:image\/(?:png|jpeg|webp|gif);base64,[a-z\d+/=]+)$/i.test(value);

function validateCss(css) {
  if (/[<\\]|expression\s*\(|javascript\s*:|(?:^|[;{])\s*behavior\s*:|-moz-binding/i.test(css)) throw designError('样式包含不支持的内容');
  let tree;try{tree=postcss.parse(css);}catch{throw designError('样式格式错误');}
  tree.walkAtRules(rule=>{if(!['media','supports','keyframes','-webkit-keyframes','container'].includes(rule.name.toLowerCase())) throw designError('不支持外部或执行性样式');});
  tree.walkDecls(d=>{
    for (const match of d.value.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) if(!safeUrl(match[2])) throw designError('样式图片需使用 HTTPS 地址');
    if(/url\s*\(/i.test(d.value) && !/url\(\s*(["']?)(.*?)\1\s*\)/i.test(d.value)) throw designError('图片地址格式错误');
  });
  return css;
}

export function validateWebsite(input) {
  if(!input || typeof input.html!=='string' || typeof input.css!=='string' || input.html.length+input.css.length>700000) throw designError('网页内容格式错误或过大');
  const css=validateCss(input.css);
  const html=sanitize(input.html,{
    allowedTags:['main','header','footer','nav','section','article','aside','div','span','p','h1','h2','h3','h4','h5','h6','a','button','img','video','source','ul','ol','li','strong','em','b','i','small','br','hr','blockquote','figure','figcaption'],
    allowedAttributes:{'*':['id','class','style','title','role','aria-label','data-motion'],a:['href','target','rel'],img:['src','alt','width','height','loading'],video:['src','poster','autoplay','muted','loop','playsinline','controls'],source:['src','type'],button:['type']},
    allowedSchemes:['https','mailto','tel','data'],allowedSchemesByTag:{img:['https','data'],video:['https'],source:['https']},allowProtocolRelative:false,
    transformTags:{'*':(tagName,attrs)=>{
      for(const attr of ['src','href','poster']) if(attrs[attr] && !safeUrl(attrs[attr])) delete attrs[attr];
      if(attrs.style) validateCss(`x{${attrs.style}}`);
      if(tagName==='a') attrs.rel='noopener noreferrer';
      if(tagName==='button') attrs.type='button';
      return {tagName,attribs:attrs};
    }},
  });
  if(!html.trim()) throw designError('网页内容为空');
  const {document}=parseHTML(`<html><body>${html}</body></html>`), ids=new Set();
  for(const el of document.querySelectorAll('[id]')) {
    if(!/^[a-zA-Z][\w-]{0,100}$/.test(el.id)||ids.has(el.id)) throw designError('页面元素标识无效或重复');
    ids.add(el.id);
  }
  return {html,css};
}

export function selectedHtml(doc,targetId) {
  const {document}=parseHTML(`<html><body>${doc.html}</body></html>`);
  const target=document.getElementById(targetId);
  if(!target || target===document.body) throw designError('选中元素不存在');
  return target.outerHTML;
}

export function patchWebsite(base,targetId,answer) {
  const valid=validateWebsite(base), fragment=validateWebsite({html:answer?.html,css:''});
  const {document}=parseHTML(`<html><body>${valid.html}</body></html>`);
  const target=document.getElementById(targetId);
  const replacement=parseHTML(`<html><body>${fragment.html}</body></html>`).document.body;
  if(!target || target===document.body || replacement.children.length!==1 || replacement.firstElementChild.id!==targetId || [...replacement.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())) throw designError('模型必须只返回选中元素，并保持其标识');
  target.replaceWith(replacement.firstElementChild);
  return validateWebsite({html:document.body.innerHTML,css:valid.css});
}

export function exportWebsite(doc,title='我的网站') {
  const safe=validateWebsite(doc);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; media-src https:; style-src 'unsafe-inline'; font-src https:; base-uri 'none'; form-action 'none'"><title>${escapeHtml(title)}</title><style>${safe.css}</style></head><body>${safe.html}</body></html>`;
}
