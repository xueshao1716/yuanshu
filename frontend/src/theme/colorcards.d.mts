// 配色卡模块的类型合同（engine/color-cards.mjs 在前端的转出口）。
// 为什么要写它：前端只有这里消费这些 `.mjs`，没有声明文件时 TS 把它们当 unknown，
// 于是 `Object.values(CARD_FAMILIES).map(f => f.id)` 会报 "Property 'id' does not exist on type 'unknown'"。
// 类型检查现在是仓库的一条硬线（tests/unit/frontend-typecheck.test.mjs），所以这份声明必须跟着引擎走。
export interface ColorCard {
  id: string
  family: 'morandi' | 'vivid'
  name: string
  from: string
  to: string
  top: string
  bottom: string
  aliases?: string[]
  tone: string
}

export interface ColorCardFamily {
  id: 'morandi' | 'vivid'
  name: string
  short: string
  rule: string
}

export declare const COLOR_CARDS: readonly ColorCard[]
export declare const MORANDI_CARDS: readonly ColorCard[]
export declare const VIVID_CARDS: readonly ColorCard[]
export declare const CARD_FAMILIES: Record<string, ColorCardFamily>
export declare const SHELL_TINT: { left: number; right: number; top: number; edge: number }

export declare function resolveColorCard(input: unknown): ColorCard | null
export declare function colorCardGradient(card: ColorCard | null | undefined): string
export declare function colorCardRule(card: ColorCard | string | null | undefined): string
export declare function colorCardOn(card: ColorCard | string | null | undefined): string
export declare function colorCardPillVars(card: ColorCard | string | null | undefined): Record<string, string>
export declare function colorCardShellVars(card: ColorCard | string | null | undefined): Record<string, string>
