import { AsyncLocalStorage } from 'node:async_hooks';
import { executeTeam, DELEGATE_TEAM_TOOL } from './team-subagents.mjs';

const context = new AsyncLocalStorage();
export const withTeamToolContext = (value, work) => context.run(value, work);
export function createPiTeamTool(Type) {
  return {
    name: 'delegate_team', label: '天团协作', description: DELEGATE_TEAM_TOOL.function.description,
    parameters: Type.Object({ task: Type.String(), context: Type.Optional(Type.Array(Type.String())) }),
    async execute(_id, args, signal) {
      const host = context.getStore();
      const signals = [host?.signal, signal].filter(Boolean);
      const r = await executeTeam(args, { ...host, signal: signals.length ? AbortSignal.any(signals) : undefined });
      return { content: [{ type: 'text', text: r.text }], details: { artifact: r.artifact, children: r.children, delivery: r.delivery }, isError: r.isError };
    },
  };
}
