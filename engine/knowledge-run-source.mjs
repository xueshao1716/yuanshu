import {reviewStoragePath} from './review-file-safety.mjs';
import {readReviewBounded} from './review-read.mjs';
import {fail} from './knowledge-state.mjs';

// Only exact assistant deltas are material, never tool logs or success claims as proof.
export function knowledgeRunOutput(runRoot,run,{required=false}={}){
  if(!runRoot){if(required)fail('source_missing');return '';}
  try{
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(run.id))fail('source_missing');
    const raw=readReviewBounded(reviewStoragePath(runRoot,`events/${run.id}.jsonl`),4*1024*1024).toString('utf8');
    const events=raw.split('\n').filter(Boolean).map(row=>JSON.parse(row));
    if(events.length>10000||events.some((e,i)=>e.runId!==run.id||e.sessionId!==run.sessionId||e.seq!==i+1))fail('source_missing');
    const text=events.filter(e=>e.type==='delta'&&typeof e.data?.text==='string').map(e=>e.data.text).join('');
    if(Buffer.byteLength(text)>1024*1024)fail('source_too_large');
    if(required&&!text.trim())fail('source_missing');return text;
  }catch(e){if(e.code==='ENOENT'&&!required)return '';fail(e.code==='source_too_large'?e.code:'source_missing');}
}
