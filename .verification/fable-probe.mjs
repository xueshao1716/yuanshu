import fs from 'node:fs';
import { httpRawFetch } from '../engine/http.mjs';
import { readOpenAIChatStream } from '../engine/openai-stream.mjs';
import { BASE_TOOL_SCHEMAS, SHARE_PROJECT_SCHEMA } from '../engine/tools/unified-tools.mjs';
import { MEDIA_TOOL_SCHEMAS } from '../engine/media-channels.mjs';
import { TODO_TOOL_SCHEMAS } from '../engine/yuanshu-todo.mjs';
import { PLAN_FILES_SCHEMA } from '../engine/yuanshu-workmem.mjs';
import { ACTIVATE_SKILL_TOOL } from '../engine/context-loader.mjs';
import { DELEGATE_TASK_TOOL, DELEGATE_FORK_TOOL } from '../engine/yuanshu-delegate.mjs';
import { DELEGATE_TEAM_TOOL } from '../engine/team-subagents.mjs';
const dir = 'C:/Users/xuexiaofeng/.pi/agent';
const store = JSON.parse(fs.readFileSync(`${dir}/models-store.json`, 'utf8'));
const auth = JSON.parse(fs.readFileSync(`${dir}/auth.json`, 'utf8'));
const m = store['aieyra-claude'].models.find(m => m.id === 'claude-fable-5-1');
const stream = process.argv[2] !== 'json';
const task = process.argv.includes('tools');
const replay = process.argv.includes('history');
const original = replay ? fs.readFileSync(`${dir}/pi-web-runs/events/31343968-fdfc-49f7-a313-d9a32db23fcf.jsonl`,'utf8').trim().split('\n').map(JSON.parse).find(e=>e.type==='checkpoint'&&e.data.messages?.length).data.messages : null;
const messages = original || [{role:'user',content:task?'Use echo_check to check value 7, then report the returned value.':'Reply with exactly OK.'}];
const full = process.argv.includes('full');
const tools = full ? [...BASE_TOOL_SCHEMAS,SHARE_PROJECT_SCHEMA,...MEDIA_TOOL_SCHEMAS,...TODO_TOOL_SCHEMAS,PLAN_FILES_SCHEMA,ACTIVATE_SKILL_TOOL,DELEGATE_TASK_TOOL,DELEGATE_FORK_TOOL,DELEGATE_TEAM_TOOL] : [{type:'function',function:{name:'echo_check',description:'Echo a number',parameters:{type:'object',properties:{value:{type:'number'}},required:['value']}}}];
const r = await httpRawFetch(`${m.baseUrl}/chat/completions`, {
  method: 'POST', headers: {'Content-Type':'application/json', Authorization: `Bearer ${auth['aieyra-claude'].key}`},
  body: JSON.stringify({model:m.id,messages,stream,max_tokens:task?32768:replay?1024:256,...(task?{reasoning_effort:'high',tools,tool_choice:'auto'}:{})}),
  timeout:60000, signal:AbortSignal.timeout(60000),
});
const raw = await r.text();
const parsed = await readOpenAIChatStream(new Response(raw).body);
const objects = stream ? raw.split(/\r?\n/).filter(s=>s.startsWith('data:')).map(s=>{try{return JSON.parse(s.slice(5))}catch{return null}}).filter(Boolean) : [JSON.parse(raw)];
console.log(JSON.stringify({status:r.status,stream,bytes:raw.length,topKeys:objects.slice(0,3).map(x=>Object.keys(x)),types:[...new Set(objects.map(x=>x.type).filter(Boolean))],textLength:parsed.message?.content?.length,toolCount:parsed.message?.tool_calls?.length,finishReason:parsed.finishReason,error:parsed.error,shape:replay?undefined:objects.slice(0,2)},null,2));
