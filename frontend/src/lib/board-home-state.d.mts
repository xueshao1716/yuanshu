export function chooseResumeSession<T extends { id: string; updatedAt?: string; createdAt?: string }>(sessions: readonly T[]): T | null;
