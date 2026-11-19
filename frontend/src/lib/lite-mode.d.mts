export type LitePref = 'auto' | 'on' | 'off'
export function getLitePref(): LitePref
export function detectSoftwareRender(doc?: Document | null): boolean
export function isLite(): boolean
export function lessMotion(): boolean
export function applyLiteMode(pref?: LitePref): boolean
export function setLitePref(pref: LitePref): boolean
