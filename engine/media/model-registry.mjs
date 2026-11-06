// Only protocol adapters implemented by the bridge belong here. Catalog inference is not enough.
export const DEFAULT_VOICE_MODEL = 'stepfun-plan/stepaudio-2.5-realtime';
const adapters = Object.freeze([
  Object.freeze({ modelKey: DEFAULT_VOICE_MODEL, provider: 'stepfun-plan', id: 'stepaudio-2.5-realtime',
    name: 'StepAudio 2.5 · 实时通话', endpoint: 'wss://api.stepfun.com/step_plan/v1/realtime' }),
]);

export function voiceModelDefinition(modelKey = DEFAULT_VOICE_MODEL) {
  const model = adapters.find(m => m.modelKey === modelKey);
  if (!model) throw new Error('voice_model_unsupported');
  return model;
}

export function createVoiceModelRegistry({ readAuth, getModels = () => [] }) {
  function resolve(modelKey = DEFAULT_VOICE_MODEL) {
    const model = voiceModelDefinition(modelKey);
    const configured = getModels().find(m => m.provider === model.provider && m.id === model.id);
    const key = readAuth()?.[model.provider]?.key;
    if (configured?.enabled === false || configured?.capabilities?.realtime === false || typeof key !== 'string' || !key.trim()) {
      throw new Error('voice_model_unavailable');
    }
    return { ...model, key };
  }
  function list() {
    return adapters.flatMap(model => {
      try { resolve(model.modelKey); } catch { return []; }
      return [{ modelKey: model.modelKey, id: model.id, provider: model.provider, name: model.name }];
    });
  }
  return { list, resolve };
}
