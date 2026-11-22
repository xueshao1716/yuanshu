export type Typography = { scale: number; chatSize: number; letterSpacing: number; lineHeight: number }
export type TypoKey = keyof Typography
export const TYPO_DEFAULTS: Readonly<Typography>
export const TYPO_LIMITS: Readonly<Record<TypoKey, [number, number, number]>>
export function normalizeTypography(raw: unknown): Typography
export function getTypography(): Typography
export function typographyVars(t: Partial<Typography>): Record<string, string>
export function applyTypography(t?: Partial<Typography>): void
export function setTypography(patch: Partial<Typography> | null): Typography
