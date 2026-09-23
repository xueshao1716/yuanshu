export type Scene = { id: string; label: string; title: string; bg: string; ink: string; accent: string; floor: string };
export type Idea = { date: string; title: string; text: string };
export const SCENES: Scene[];
export function sceneFor(id: unknown): Scene;
export function dailyIdea(now?: Date, offset?: number): Idea;
export function sceneBackdrop(id: string): string;
