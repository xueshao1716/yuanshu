import { createHash } from 'node:crypto';
/** Resolve through the existing session registry, never a caller-supplied file. */
export function createCompanionSessionReader({ activeSessions, findSession, readEntriesFromFile, extractMessages, resolveLeafId, getModels, getDefaultModel, isAutoModel = m => m?.provider === 'auto' || m?.id === 'auto' }) {
  return id => {
    const active = activeSessions.get(id), found = active ? null : findSession(id);
    if (!active && !found) return null;
    const entries = active?.sm?.fileEntries || readEntriesFromFile(found.file);
    const leaf = active?.sm?.getLeafId?.() || resolveLeafId(entries);
    const byId = new Map(entries.map(e => [e.id, e])), seen = new Set();
    let node = byId.get(leaf), lastModel;
    while (node && !seen.has(node.id)) {
      seen.add(node.id);
      if (node.type === 'model_change' && node.provider && node.modelId) { lastModel = node; break; }
      node = byId.get(node.parentId);
    }
    const chosen = active?.modelKey || (lastModel && { provider: lastModel.provider, id: lastModel.modelId });
    const preferred = !chosen || isAutoModel(chosen) ? getDefaultModel() : chosen;
    const model = getModels().find(m => m.provider === preferred?.provider && m.id === preferred?.id);
    if (!model) return null;
    const messages = extractMessages(entries, leaf).filter(m => ['user', 'assistant'].includes(m.role))
      .map(m => ({ role: m.role, content: m.text }));
    const revision = createHash('sha256').update(JSON.stringify([leaf, entries.length, entries.at(-1)?.id, model.provider, model.id, messages.slice(-6)])).digest('hex').slice(0, 24);
    return { model, messages, revision };
  };
}
