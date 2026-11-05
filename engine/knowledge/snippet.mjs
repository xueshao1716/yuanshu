export function knowledgeTerms(text){
  const normalized=String(text||'').toLowerCase();
  return [...new Set([...(normalized.match(/[a-z0-9_]{2,}/g)||[]),...(normalized.match(/[\u3400-\u9fff]+/g)||[])
    .flatMap(s=>Array.from({length:Math.max(0,s.length-1)},(_,i)=>s.slice(i,i+2)))])].slice(0,100);
}
// A contiguous exact slice, measured with the caller's complete serialized framing.
// Offsets stay UTF-16 source offsets; never split a surrogate pair or rewrite evidence.
export function fitKnowledgeSnippet({text,focus='',fits,maxCharacters=1200}){
  const value=String(text||''),lower=value.toLowerCase(),query=String(focus||'').toLowerCase().trim();
  let match=query&&query.length<=64?lower.indexOf(query):-1,matched=match<0?'':query;
  if(match<0)for(const term of knowledgeTerms(query)){const at=lower.indexOf(term);if(at>=0){match=at;matched=term;break;}}
  const characters=Array.from(value),offsets=[0];for(const char of characters)offsets.push(offsets.at(-1)+char.length);
  const point=match<0?0:offsets.findIndex(n=>n>=match),minimum=Math.max(1,Array.from(matched).length);
  const slice=size=>{
    const start=Math.max(0,Math.min(characters.length-size,point-Math.floor(Math.max(0,size-minimum)/3)));
    return {text:characters.slice(start,start+size).join(''),offset:offsets[start],length:offsets[start+size]-offsets[start]};
  };
  let low=minimum,high=Math.min(characters.length,maxCharacters),best=null;
  while(low<=high){const size=Math.floor((low+high)/2),candidate=slice(size);
    if(fits(candidate)){best=candidate;low=size+1;}else high=size-1;
  }
  return best;
}
