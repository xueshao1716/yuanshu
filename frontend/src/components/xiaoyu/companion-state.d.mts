export type CompanionAction = 'neutral' | 'working' | 'reading' | 'resting' | 'daydreaming' | 'listening' | 'responding';
export interface CompanionFacts { sessionId: string; serverEpoch: string; revision: string; observedAt: number; known: boolean; currentBusy: boolean; otherBusy: number; reading: boolean; evidenceIds: string[] }
export interface CompanionDecision { sessionId: string; contextEpoch: string; serverEpoch: string; basisRevision: string; expiresAt: number; action: CompanionAction; utterance: string; reason: string; decisionId: string; shouldInterrupt: boolean; actualModel: { provider: string; id: string } }
export const ACTION_LABELS: Record<CompanionAction, string>;
export const PORTRAITS: Record<string, { src: string; accepted: boolean }>;
export function portraitFor(action: string, manifest?: typeof PORTRAITS): { src: string; missing: boolean };
export function actionFor(facts: CompanionFacts | null | undefined, decision?: CompanionDecision | null): CompanionAction;
export function acceptDecision(decision: CompanionDecision | null | undefined, context: { sessionId: string | null; contextEpoch: string; facts: CompanionFacts | null | undefined; now: number; visible: boolean }): boolean;
export function shouldAutoDecide(input: { visible: boolean; dnd: boolean; sessionId: string | null; known: boolean; key: string; previous: string; pending?: boolean; currentBusy?: boolean }): boolean;
export function isConversationEvent(event: unknown): boolean;
