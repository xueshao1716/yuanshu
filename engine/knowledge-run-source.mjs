import {reviewStoragePath} from './review-file-safety.mjs';
import {readReviewBounded} from './review-read.mjs';
import {fail} from './knowledge-state.mjs';

// 事件日志上限：长任务的 think 流是逐字事件，一轮动辄 1~3 万条、20~30MB。
// 原来卡在 4MB / 1 万条，实测 873 个运行里 129 个超限——恰好是最有内容的长任务全被当成 source_missing（2026-10-06）。
export const RUN_EVENTS_MAX_BYTES=64*1024*1024;
export const RUN_EVENTS_MAX_COUNT=300000;

// Only exact assistant deltas are material, never tool logs or success claims as proof.
export function knowledgeRunOutput(runRoot,run,{required=false}={}){
  if(!runRoot){if(required)fail('source_missing');return '';}
  try{
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(run.id))fail('source_missing');
    const raw=readReviewBounded(reviewStoragePath(runRoot,`events/${run.id}.jsonl`),RUN_EVENTS_MAX_BYTES).toString('utf8');
    const events=raw.split('\n').filter(Boolean).map(row=>JSON.parse(row));
    if(events.length>RUN_EVENTS_MAX_COUNT||events.some((e,i)=>e.runId!==run.id||e.sessionId!==run.sessionId||e.seq!==i+1))fail('source_missing');
    const text=events.filter(e=>e.type==='delta'&&typeof e.data?.text==='string').map(e=>e.data.text).join('');
    if(Buffer.byteLength(text)>1024*1024)fail('source_too_large');
    if(required&&!text.trim())fail('source_missing');return text;
  }catch(e){
    // 非必需的探测（任务来源阶段顺手看一眼有没有输出）读不了就当没有，不能拖累用户输入那份来源一起 blocked
    if(!required)return '';
    fail(e.code==='source_too_large'?e.code:'source_missing');}
}
