import {clonePayload} from './state.mjs';
import {exact} from './control-state.mjs';
import {designValidationDetails} from './designs.mjs';
import {cultivationFailureDetails} from './diagnostics.mjs';

const fail = code => {throw new Error(`cultivation_${code}`);};
const publicErrors = new Set(['identity_unavailable', 'identity_denied', 'identity_expired',
  'invalid_command', 'invalid_payload', 'invalid_design', 'invalid_policy', 'invalid_cursor',
  'invalid_pagination', 'invalid_scope', 'invalid_transition', 'invalid_control', 'invalid_record',
  'revision_conflict', 'idempotency_conflict', 'cursor_stale', 'initialization_conflict',
  'policy_disabled', 'policy_expired', 'request_denied', 'permission_expansion', 'population_limit',
  'protected_proposal_pending', 'asset_unverified', 'design_lineage', 'design_not_found',
  'agent_not_found', 'run_not_found', 'executor_unavailable', 'unsupported_permissions',
  'agent_paused', 'policy_changed', 'independent_evidence_required', 'data_not_authorized', 'recovery_unavailable', 'learning_changed', 'route_not_found', 'state_unreadable', 'state_changing', 'storage_full', 'audit_full']);
function errorReply(error) {
  const suffix = String(error?.message ?? '').replace(/^cultivation_/, '');
  const code = publicErrors.has(suffix) ? suffix : 'unavailable';
  const status = /conflict|cursor_stale/.test(code) ? 409 : /not_found/.test(code) ? 404 :
    /identity_denied|identity_expired/.test(code) ? 403 :
    /unavailable|unreadable|invalid_control|invalid_record|state_changing|storage_full|audit_full/.test(code) ? 503 : 400;
  return {status, body: cultivationFailureDetails(error) ?? designValidationDetails(error) ?? {error: `cultivation_${code}`}};
}
function writeAction(method, route) {
  if (method === 'PUT' && route === '/policy') return {action: 'policy.set'};
  if (method !== 'POST') fail('route_not_found');
  if (route === '/designs') return {action: 'design.submit'};
  if (route === '/agents') return {action: 'agent.register'};
  if (route === '/runs') return {action: 'run.submit'};
  if (route === '/learning') return {action:'learning.decide'};
  if (route === '/assets/revoke') return {action:'asset.revoke'};
  if (route === '/resources/reconcile') return {action:'resources.reconcile'};
  const run = route.match(/^\/runs\/([a-f0-9-]{36})\/cancel$/);
  if (run) return {action: 'run.cancel', key: 'runId', id: run[1]};
  const design = route.match(/^\/designs\/([a-f0-9-]{36})\/revise$/);
  if (design) return {action: 'design.revise', key: 'parentId', id: design[1]};
  const agent = route.match(/^\/agents\/([a-f0-9-]{36})\/(pause|resume|archive|adopt|rollback)$/);
  if (agent) return {action: `agent.${agent[2]}`, key: 'agentId', id: agent[1]};
  fail('route_not_found');
}
export function commandFor(method,route,input) {
  const target=writeAction(method,route),body=clonePayload(input);
  if(!exact(body,['requestId','expectedRevision','payload'])||!body.payload||
    typeof body.payload!=='object'||Array.isArray(body.payload))fail('invalid_command');
  if(target.key&&Object.hasOwn(body.payload,target.key))fail('invalid_command');
  return {...body,action:target.action,payload:{...body.payload,...(target.key?{[target.key]:target.id}:{})}};
}
export function createCultivationApi({runtime, readBody, json, requireAuth, resolveRequestIdentity}) {
  return Object.freeze({async handle(req, res, url) {
    try {
      if (await requireAuth?.(req) !== true) return json(res, 401, {error: 'authentication_required'});
      const route = url.pathname.slice('/api/cultivation'.length);
      if (req.method === 'GET') {
        if(route==='/preflight')return json(res,200,await runtime.preflight(Object.fromEntries(url.searchParams)));
        if(route==='/models')return json(res,200,await runtime.models());
        if(route==='/denials')return json(res,200,runtime.denials());
        if(route==='/media'){
          res.setHeader?.('Cache-Control','no-store');res.setHeader?.('X-Content-Type-Options','nosniff');
          return json(res,200,runtime.media({agentId:url.searchParams.get('agentId'),kind:url.searchParams.get('kind'),
            id:url.searchParams.get('id'),version:Number(url.searchParams.get('version'))}));
        }
        if (route === '/overview') return json(res, 200, await runtime.overview());
        if (['/agents', '/designs', '/events', '/runs', '/experience'].includes(route))
          return json(res, 200, await runtime.list(route.slice(1), {limit: Number(url.searchParams.get('limit') ?? 20),
            cursor: url.searchParams.get('cursor')}));
        const match = route.match(/^\/agents\/([a-f0-9-]{36})$/);
        if (match) {const detail = runtime.detail(match[1]); if (!detail) fail('agent_not_found'); return json(res, 200, detail);}
        fail('route_not_found');
      }
      const sessionProofHeader=req.headers?.['x-cultivation-session-proof'];
      const sessionRoute=req.method==='POST'&&['/grants/session/challenge','/grants/session/confirm'].includes(route);
      if (!runtime.writeIdentityAvailable && !(runtime.sessionGrantAvailable &&
          (sessionRoute || typeof sessionProofHeader==='string'))) fail('identity_unavailable');
      let input;
      try {input = await readBody(req); if (typeof input === 'string') input = JSON.parse(input);} catch {fail('invalid_command');}
      if(req.method==='POST'&&route==='/grants/challenge'){
        if(!exact(input,['method','path','body'])||typeof input.path!=='string')fail('invalid_command');
        if (!runtime.writeIdentityAvailable) fail('identity_unavailable');
        return json(res,200,runtime.challenge(commandFor(input.method,input.path,input.body)));
      }
      if(req.method==='POST'&&route==='/grants/session/challenge'){
        if(!exact(input,['method','path','body','sessionId'])||typeof input.path!=='string'||typeof input.sessionId!=='string')fail('invalid_command');
        return json(res,200,runtime.sessionChallenge(commandFor(input.method,input.path,input.body),input.sessionId));
      }
      if(req.method==='POST'&&route==='/grants/session/confirm'){
        if(!exact(input,['id','method','path','body','sessionId'])||typeof input.id!=='string'||
            typeof input.path!=='string'||typeof input.sessionId!=='string')fail('invalid_command');
        return json(res,200,await runtime.sessionConfirm(input.id,commandFor(input.method,input.path,input.body),input.sessionId));
      }
      const command=commandFor(req.method,route,input);
      // Trusted host adapter only; the request body cannot choose actor or role.
      let identity;
      if(typeof sessionProofHeader==='string'){
        if(sessionProofHeader.length>9000)fail('identity_denied');
        let proof;try{proof=JSON.parse(sessionProofHeader);}catch{fail('identity_denied');}
        const sessionId=req.headers?.['x-cultivation-session-id'];
        if(typeof sessionId!=='string')fail('identity_denied');
        identity=runtime.verifySession(proof,command,sessionId);
      }else if(typeof resolveRequestIdentity==='function')identity=resolveRequestIdentity(req,clonePayload(command));
      else {
        const header=req.headers?.['x-cultivation-proof'];let proof;
        if(typeof header!=='string'||header.length>9000)fail('identity_denied');
        try{proof=JSON.parse(header);}catch{fail('identity_denied');}
        identity=runtime.verifyHuman(proof,command);
      }
      if (identity instanceof Promise) {identity.catch(() => {}); fail('identity_denied');}
      if (!identity) fail('identity_denied');
      return json(res, 200, await runtime.execute(command, identity.kind, identity.source));
    } catch (error) {const reply = errorReply(error); return json(res, reply.status, reply.body);}
  }});
}
