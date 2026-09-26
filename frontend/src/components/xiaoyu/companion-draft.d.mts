export function queueDraft(storage: Storage, sessionId: string | null | undefined, text: string, now?: number): boolean;
export function takeDraft(storage: Storage, sessionId: string | null | undefined, now?: number): string | null;
export function mergeDraft(existing: string, next: string): string;
