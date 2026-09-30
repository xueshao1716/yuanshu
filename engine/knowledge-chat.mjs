const unavailable='知识检索暂不可用，本次对话仍可继续。';
const notify=note=>{try{note(unavailable);}catch{}};
export async function knowledgeChatContext(runtime,input,note=()=>{}){
 try{const result=await runtime.context(input);if(result.available===false)notify(note);return result.context||'';}
 catch{notify(note);return '';}
}
export async function deliverKnowledgeContext(agent,context,note=()=>{}){
 if(!context)return;
 try{await agent?.sendCustomMessage?.({customType:'context',content:[{type:'text',text:context}]},{deliverAs:'nextTurn'});}
 catch{notify(note);}
}
