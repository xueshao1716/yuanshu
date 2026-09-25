import {httpRawFetch} from './http.mjs';
import {readMessagesStream} from './anthropic-stream.mjs';
import {readOpenAIChatStream} from './openai-stream.mjs';

const failure=(message,code,statusCode=502)=>Object.assign(new Error(message),{code,statusCode});

// Own both headers and body lifetime. Heartbeats do not extend useful-work idle time.
export async function directChatStream(url,request,api,opts={}) {
  const controller=new AbortController(),signal=controller.signal;
  let reader,idle,bytes=0,characters=0,thinkingCharacters=0;
  const abort=()=>controller.abort(opts.signal.reason);
  const deadline=setTimeout(()=>controller.abort(failure('模型本次调用达到总时限，已有片段保留','MODEL_DEADLINE',504)),opts.timeout||300000);
  const touch=()=>{clearTimeout(idle);idle=setTimeout(()=>controller.abort(failure('模型长时间没有新内容，已有片段保留，可继续','MODEL_IDLE_TIMEOUT',504)),opts.idleTimeout||90000);};
  const stopReader=()=>{void reader?.cancel().catch(()=>{});};
  signal.addEventListener('abort',stopReader,{once:true});
  opts.signal?.addEventListener('abort',abort,{once:true});
  if(opts.signal?.aborted)abort();
  const progress=phase=>opts.onProgress?.({phase,characters,thinkingCharacters,at:new Date().toISOString()});
  try {
    signal.throwIfAborted();touch();progress('waiting');
    const response=await httpRawFetch(url,{...request,signal,timeout:opts.timeout||300000});
    signal.throwIfAborted();
    if(!response.ok){await response.body?.cancel();return {status:response.status,ok:false};}
    reader=response.body?.getReader();
    if(!reader)throw failure('模型流没有可读取内容','MODEL_STREAM_INCOMPLETE');
    // A guarded reader cancels immediately even while the codec awaits read().
    const body={getReader:()=>({
      async read(){signal.throwIfAborted();const item=await reader.read();signal.throwIfAborted();bytes+=item.value?.byteLength||0;if(bytes>16*1024*1024)throw failure('模型流超出安全大小，已有片段保留','MODEL_STREAM_LIMIT',422);return item;},
      cancel:()=>reader.cancel(),releaseLock:()=>{},
    })};
    const callbacks={signal,onDelta:text=>{touch();characters+=text.length;opts.onDelta?.(text);progress('output');},
      onThink:text=>{touch();thinkingCharacters+=text.length;progress('thinking');}};
    const parsed=await (api==='anthropic-messages'?readMessagesStream:readOpenAIChatStream)(body,callbacks);
    signal.throwIfAborted();
    if(parsed.error||parsed.aborted||!parsed.finishReason)throw failure('模型流未完整结束，已有片段保留，可继续','MODEL_STREAM_INCOMPLETE');
    // JSON fallback codecs may not emit deltas (Messages); persist its answer once.
    if(!characters&&parsed.message?.content)callbacks.onDelta(parsed.message.content);
    return {ok:true,status:response.status,...parsed};
  } catch(error) {
    if(signal.aborted)throw signal.reason;
    if(error?.code?.startsWith('MODEL_'))throw error;
    throw failure('模型连接中断，已有片段保留，请检查通道后继续','MODEL_STREAM_INTERRUPTED');
  } finally {
    clearTimeout(deadline);clearTimeout(idle);
    opts.signal?.removeEventListener('abort',abort);signal.removeEventListener('abort',stopReader);
    await reader?.cancel().catch(()=>{});reader?.releaseLock();
  }
}
