import { effectiveCapabilities } from './model-capabilities.mjs';

export const modelKey = model => JSON.stringify([model.provider, model.id]);
export const mediaModels = (models, kind) => models.filter(m => m.enabled !== false && effectiveCapabilities(m)[kind] === true);
// A removed selection stays missing. Never silently substitute a billable model.
export const selectMediaModel = (models, kind, key) => mediaModels(models, kind).find(m => modelKey(m) === key);
