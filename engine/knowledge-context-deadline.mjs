// Foreground lookups must not hold chat indefinitely. Cancellation is cooperative:
// synchronous filesystem work still needs to return control to the event loop.
export async function boundedKnowledgeContext(read,{signal,timeoutMs=1500}={}){
  signal?.throwIfAborted();
  const controller=new AbortController();let timer;
  const cancel=()=>controller.abort(signal.reason);
  const stopped=new Promise((_,reject)=>{
    controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true});
  });
  signal?.addEventListener('abort',cancel,{once:true});
  try{
    timer=setTimeout(()=>controller.abort(new DOMException('Knowledge lookup timed out','TimeoutError')),
      Number.isFinite(timeoutMs)?Math.max(1,Math.min(1500,timeoutMs)):1500);
    // Capture synchronous throws as well, so an abort during read cannot leave
    // the cancellation promise without a rejection handler.
    const result=await Promise.race([(async()=>read(controller.signal))(),stopped]);
    controller.signal.throwIfAborted();
    return result;
  }finally{
    clearTimeout(timer);signal?.removeEventListener('abort',cancel);
  }
}
