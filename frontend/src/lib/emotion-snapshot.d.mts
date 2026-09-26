export interface EmotionSnapshot {
  state: any; scope: 'global-latest'; observedAt: number | null; servedAt: number;
  sourceKind: 'dialogue' | 'historical' | 'none'; revision: number; serverEpoch: string;
  status: 'observed' | 'historical' | 'unavailable';
}
export function acceptEmotionSnapshot(current: EmotionSnapshot | null, next: EmotionSnapshot, authoritative?: boolean): EmotionSnapshot | null;
export function emotionConnectionStatus(snapshot: EmotionSnapshot | null, now?: number, receivedAt?: number | null): 'observed' | 'historical' | 'unavailable' | 'stale';
export function createEmotionReceiver(): { begin(): number; receive(ticket: number, snapshot: EmotionSnapshot, now?: number): EmotionSnapshot | null; read(): { value: EmotionSnapshot | null; receivedAt: number | null } };
