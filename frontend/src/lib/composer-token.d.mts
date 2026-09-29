export interface ComposerToken { kind: 'slash' | 'at'; query: string; start: number; end: number }
export function composerToken(value: string, caret?: number, selectionEnd?: number): ComposerToken | null;
export function removeComposerToken(value: string, token: ComposerToken | null): string;
