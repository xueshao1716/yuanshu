import {boundedKnowledgeContext} from './knowledge-context-deadline.mjs';
const unavailable='知识检索暂不可用，本次对话仍可继续。';
const notify=note=>{try{note(unavailable);}catch{}};
export async function knowledgeChatContext(runtime,input,note=()=>{}){
 try{const result=await boundedKnowledgeContext(signal=>runtime.context({...input,signal}),input);
   // 只有"知识库真坏了"才出"暂不可用"卡；本来就不检索的任务轮次、用户主动中断不算（2026-10-11 消除误报噪音）。
   if(result.available===false){if(result.reason==='knowledge_unavailable'&&!input.signal?.aborted)notify(note);return '';}
   return result.context||'';}
 catch{if(!input.signal?.aborted)notify(note);return '';}
}
export async function deliverKnowledgeContext(agent,context,note=()=>{}){
 if(!context)return;
 try{await agent?.sendCustomMessage?.({customType:'context',content:[{type:'text',text:context}]},{deliverAs:'nextTurn'});}
 catch{notify(note);}
}
