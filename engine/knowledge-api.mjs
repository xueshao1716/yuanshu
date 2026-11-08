import {fail} from './knowledge-state.mjs';
const publicCode=e=>/^[a-z][a-z0-9_]{0,70}$/.test(e?.code||'')?e.code:'knowledge_unavailable';
export function createKnowledgeApi({runtime,readBody,json,requireAuth}){
  return {async handle(req,res,url){
    if(!requireAuth(req))return json(res,401,{error:'authentication_required'});
    try{
      const path=url.pathname;
      if(req.method==='GET'){
        if(path==='/api/knowledge/status')return json(res,200,await runtime.status());
        if(path==='/api/knowledge/policy')return json(res,200,await runtime.store.policy());
        if(path==='/api/knowledge/models')return json(res,200,await runtime.models());
        if(path==='/api/knowledge/jobs'){
          const offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||20);
          if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)fail('invalid_pagination');
          return json(res,200,await runtime.store.list({offset,limit}));
        }
        const match=path.match(/^\/api\/knowledge\/jobs\/([a-f0-9]{64})$/);
        if(match){const job=await runtime.detail(match[1]);return json(res,job?200:404,job||{error:'job_not_found'});}
      }else if(req.method==='POST'){
        let body;try{body=await readBody(req);if(typeof body==='string')body=JSON.parse(body);}catch{fail('invalid_request');}
        if(!body||!Number.isInteger(body.revision)||body.revision<1)fail('invalid_request');
        if(path==='/api/knowledge/policy')return json(res,200,await runtime.updatePolicy(body.patch,body.revision));
        if(path==='/api/knowledge/enqueue')return json(res,202,await runtime.enqueue(body.source,body.revision));
        const review=path.match(/^\/api\/knowledge\/jobs\/([a-f0-9]{64})\/review$/);
        if(review){
          if(!Number.isInteger(body.policyRevision)||body.policyRevision<1)fail('invalid_request');
          const decision={decision:body.decision,note:body.note,confirmed:body.confirmed,selectedEntryId:body.selectedEntryId};
          return json(res,200,await runtime.review(review[1],decision,body.revision,body.policyRevision));
        }
        const supplement=path.match(/^\/api\/knowledge\/jobs\/([a-f0-9]{64})\/supplement$/);
        if(supplement){
          if(!Number.isInteger(body.policyRevision)||body.policyRevision<1)fail('invalid_request');
          return json(res,202,await runtime.supplement(supplement[1],body.source,body.revision,body.policyRevision));
        }
        const match=path.match(/^\/api\/knowledge\/jobs\/([a-f0-9]{64})\/control$/);
        if(match)return json(res,200,await runtime.control(match[1],body.action,body.revision));
      }
      return json(res,404,{error:'knowledge_route_not_found'});
    }catch(e){const error=publicCode(e);return json(res,error==='revision_conflict'?409:error==='job_not_found'?404:
      /unavailable|unreadable|storage_full/.test(error)?503:400,{error});}
  }};
}
