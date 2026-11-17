export const CHOICE_EVENT: 'pi-chat-reply'
export interface ChoiceOption { label: string; desc?: string }
export interface ChoiceSpec { question: string; options: ChoiceOption[]; custom: boolean; skip: boolean }
export function normalizeChoice(spec: unknown): ChoiceSpec | null
export function choiceReplyText(a: { question: string; label?: string; custom?: string; skip?: boolean }): string
