import {clonePayload} from './state.mjs';
import {exact} from './control-state.mjs';

const fail = code => {throw new Error(`cultivation_${code}`);};
const publicErrors = new Set(['identity_unavailable', 'identity_denied', 'identity_expired',
  'invalid_command', 'invalid_payload', 'invalid_design', 'invalid_policy', 'invalid_cursor',
  'invalid_pagination', 'invalid_scope', 'invalid_transition', 'invalid_control', 'invalid_record',
  'revision_conflict', 'idempotency_conflict', 'cursor_stale', 'initialization_conflict',
  'policy_disabled', 'policy_expired', 'request_denied', 'permission_expansion', 'population_limit',
  'protected_proposal_pending', 'asset_unverified', 'design_lineage', 'design_not_found',
  'agent_not_found', 'route_not_found', 'state_unreadable', 'state_changing', 'storage_full', 'audit_full']);
function errorReply(error) {
  const suffix = String(error?.message ?? '').replace(/^cultivation_/, '');
  const code = publicErrors.has(suffix) ? suffix : 'unavailable';
  const status = /conflict|cursor_stale/.test(code) ? 409 : /not_found/.test(code) ? 404 :
    /identity_denied|identity_expired/.test(code) ? 403 :
    /unavailable|unreadable|invalid_control|invalid_record|state_changing|storage_full|audit_full/.test(code) ? 503 : 400;
  return {status, body: {error: `cultivation_${code}`}};
}
function writeAction(method, route) {
  if (method === 'PUT' && route === '/policy') return {action: 'policy.set'};
  if (method !== 'POST') fail('route_not_found');
  if (route === '/designs') return {action: 'design.submit'};
  if (route === '/agents') return {action: 'agent.register'};
  const design = route.match(/^\/designs\/([a-f0-9-]{36})\/revise$/);
  if (design) return {action: 'design.revise', key: 'parentId', id: design[1]};
  const agent = route.match(/^\/agents\/([a-f0-9-]{36})\/(pause|resume|archive|adopt|rollback)$/);
  if (agent) return {action: `agent.${agent[2]}`, key: 'agentId', id: agent[1]};
  fail('route_not_found');
}
export function createCultivationApi({runtime, readBody, json, requireAuth, resolveRequestIdentity}) {
  return Object.freeze({async handle(req, res, url) {
    try {
      if (await requireAuth?.(req) !== true) return json(res, 401, {error: 'authentication_required'});
      const route = url.pathname.slice('/api/cultivation'.length);
      if (req.method === 'GET') {
        if (route === '/overview') return json(res, 200, runtime.overview());
        if (['/agents', '/designs', '/events', '/runs', '/experience'].includes(route))
          return json(res, 200, runtime.list(route.slice(1), {limit: Number(url.searchParams.get('limit') ?? 20),
            cursor: url.searchParams.get('cursor')}));
        const match = route.match(/^\/agents\/([a-f0-9-]{36})$/);
        if (match) {const detail = runtime.detail(match[1]); if (!detail) fail('agent_not_found'); return json(res, 200, detail);}
        fail('route_not_found');
      }
      if (!runtime.writeIdentityAvailable || typeof resolveRequestIdentity !== 'function') fail('identity_unavailable');
      const target = writeAction(req.method, route);
      let input;
      try {input = await readBody(req); if (typeof input === 'string') input = JSON.parse(input);} catch {fail('invalid_command');}
      const body = clonePayload(input);
      if (!exact(body, ['requestId', 'expectedRevision', 'payload']) || !body.payload ||
          typeof body.payload !== 'object' || Array.isArray(body.payload)) fail('invalid_command');
      if (target.key && Object.hasOwn(body.payload, target.key)) fail('invalid_command');
      const command = {...body, action: target.action,
        payload: {...body.payload, ...(target.key ? {[target.key]: target.id} : {})}};
      // Trusted host adapter only; the request body cannot choose actor or role.
      const identity = resolveRequestIdentity(req, clonePayload(command));
      if (identity instanceof Promise) {identity.catch(() => {}); fail('identity_denied');}
      if (!identity) fail('identity_denied');
      return json(res, 200, await runtime.execute(command, identity.kind, identity.source));
    } catch (error) {const reply = errorReply(error); return json(res, reply.status, reply.body);}
  }});
}
