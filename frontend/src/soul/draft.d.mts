export const PERSONA_FIELDS: string[];
export function listLines(text: string): string[];
export function normalizeDraft(draft: Record<string, unknown>): Record<string, unknown>;
export function personaPatch(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown>;
