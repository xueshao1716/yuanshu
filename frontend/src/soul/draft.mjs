export const PERSONA_FIELDS = ['name', 'age', 'gender', 'kind', 'called', 'bond', 'inner', 'tone', 'values', 'boundaries', 'taboos', 'growth'];
export const listLines = text => String(text).split('\n').map(s => s.trim()).filter(Boolean);
export function normalizeDraft(draft) {
  return Object.fromEntries(Object.entries(draft).map(([key,value]) => [key,
    ['inner','tone','values','boundaries','taboos'].includes(key) && typeof value === 'string' ? listLines(value) : value]));
}
export function personaPatch(before, after) {
  return Object.fromEntries(PERSONA_FIELDS.filter(k => after[k] !== undefined && JSON.stringify(before[k]) !== JSON.stringify(after[k])).map(k => [k, after[k]]));
}
