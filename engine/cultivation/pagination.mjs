import {createHash} from 'node:crypto';
import {exact} from './control-state.mjs';
const fail=code=>{throw new Error(`cultivation_${code}`);};
export function pageRecords(items,workspace,collection,{limit=20,cursor=null}={}) {
  if(!Number.isInteger(limit)||limit<1||limit>50)fail('invalid_pagination');
  const revision=createHash('sha256').update(JSON.stringify(items)).digest('hex');
  let offset=0;
  if(cursor!==null){
    let row;
    try{
      if(typeof cursor!=='string'||cursor.length>512||!/^[A-Za-z0-9_-]+$/.test(cursor))fail('invalid_cursor');
      row=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
    }catch{fail('invalid_cursor');}
    if(!exact(row,['workspace','collection','revision','offset'])||row.workspace!==workspace||
      row.collection!==collection||!Number.isSafeInteger(row.offset)||row.offset<0)fail('invalid_cursor');
    if(row.revision!==revision)fail('cursor_stale');offset=row.offset;
  }
  if(offset>items.length)fail('invalid_cursor');
  const end=Math.min(offset+limit,items.length);
  return {supported:true,revision,items:structuredClone(items.slice(offset,end)),nextCursor:end<items.length?
    Buffer.from(JSON.stringify({workspace,collection,revision,offset:end})).toString('base64url'):null};
}
