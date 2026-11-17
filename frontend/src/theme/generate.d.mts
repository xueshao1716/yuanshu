// generate.mjs 的 TS 类型声明（运行时由 Vite 解析 .mjs；这里只提供类型，单一真源在 generate.mjs）
export type Seed = {
  bg: string
  text: string
  accent: string
  step: number
  light?: boolean
  overrides?: Record<string, string>
}

export declare const SEEDS: Record<string, Seed>
export declare function generateTheme(seed: Seed): Record<string, string>
export declare function motionVars(): Record<string, string>
export declare function globalVars(): Record<string, string>
export declare const SPACING: [string, number][]
export declare const Z_INDEX: [string, number][]
export declare const EASINGS: Record<string, string>
export declare function contrast(fg: string, bg: string): number
export declare const wcagLum: (hex: string) => number
export declare const THEME_ALIASES: Record<string, string>
export declare function resolveThemeId(id: string): string
